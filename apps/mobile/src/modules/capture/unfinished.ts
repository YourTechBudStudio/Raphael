/**
 * Everything on this phone that is not finished, as something a screen can draw.
 *
 * One projection, published by the capability, because the recovery list and Home's count of it are
 * the same set of facts asked two ways. The alternative - each screen reading `drafts`,
 * `attempts` and `unsaved` and working out what they mean - would put the certainty policy in two
 * components and make "is this a refusal or an unresolved save" a question two files answer
 * separately. That question decides whether someone's note gets duplicated.
 *
 * So this file derives, and it derives from `standingFor` rather than from state strings: the owner
 * is still the only thing that decides what an attempt means. What is added here is grouping,
 * ordering, scope, and which actions are actually performable - not a second opinion about
 * certainty.
 *
 * It is pure. Everything it needs is a parameter, which is what lets the ordering and the action
 * sets be tested without a database.
 */

import { createEmptyDocument } from '@raphael/content';

import { canonicalJson } from './freeze.ts';
import { factsOf, logicalStateOf, newestAttempt, type Standing } from './policy.ts';
import type {
  AcknowledgedNote,
  Destination,
  DraftProblem,
  NoteAttemptRecord,
  NoteDraftRecord,
  UnusableDraft,
} from './types.ts';

/**
 * What an unfinished note is, in the vocabulary a card writes its words from.
 *
 * Deliberately not a restatement of `Standing`: a standing answers "what may this draft's bar do",
 * and this answers "what is this, in a list of things that are not finished". A draft that has never
 * been sent has no standing worth naming and is the commonest row here.
 */
export type UnfinishedStatus =
  /** A save with no answer, and the frozen request may still be replayed. */
  | 'unresolved'
  /** A save with no answer that can no longer be replayed. Never a claim that nothing was created. */
  | 'unresolved_withdrawn'
  /** The server created it; this phone could not write that down. */
  | 'unrecorded_success'
  /** A refusal with no earlier uncertainty. Correcting it and saving again is safe. */
  | 'refused'
  /** Written here, never sent. */
  | 'draft'
  /** Created on the server, with newer writing kept here. */
  | 'remainder'
  /** The stored pair contradicts itself. Retained and reported, never repaired. */
  | 'inconsistent'
  /** Written by a different build and not openable here. Retained, never migrated or discarded. */
  | 'unusable';

/**
 * What a surface may offer for one row.
 *
 * Bounded, and every member is something the owner can actually perform for that row. An orphan
 * attempt gets no `discard`, because there is no draft to discard and the owner will not delete an
 * attempt that may stand for a creation; offering one would be a button that answers "no".
 */
export type UnfinishedAction =
  /** Open the composer over this draft. */
  | 'open'
  /** Look in the destination without creating anything. */
  | 'look_in'
  /** Copy the writing into a fresh draft under the current connection. */
  | 'copy'
  /** Write the known server result down again. Never another creation. */
  | 'record_again'
  /** Remove the writing, with the confirmation the card chooses. */
  | 'discard'
  /** Remove a local record of a success that has been shown. Never touches the server. */
  | 'dismiss';

/**
 * Which connection a row belongs to, including not knowing.
 *
 * `unknown` is not a tidier spelling of `retired`. A row whose own record could not be read may have
 * no connection column to read either, and filing it under "another server" would be this app
 * inventing an origin it explicitly does not have - the one thing the recovery copy is careful not
 * to do everywhere else.
 */
export type UnfinishedScope = 'current' | 'retired' | 'unknown';

/** Why a replay is not offered. Never a claim about whether the note exists. */
export type WithdrawnReason = 'window_ended' | 'clock_anomaly' | 'conflict' | 'unusable_payload';

export interface UnfinishedNote {
  /** Why a retained row cannot be opened. Present only on an `unusable` one. */
  readonly problem?: DraftProblem | undefined;
  /** Namespaced by its producer, so a draft and a note numbered the same are different cards. */
  readonly key: string;
  /** Null for an attempt whose draft is gone: evidence with nothing left to edit. */
  readonly draftId: string | null;
  readonly attemptId: string | null;
  readonly status: UnfinishedStatus;
  /** Ordering bucket. Lower is more pressing; see `GROUP`. */
  readonly group: number;
  /** May be empty: a draft nobody has titled is not a draft with a bad title. */
  readonly title: string;
  /** The card's second line, when there is one. Never a body excerpt. */
  readonly description: string;
  readonly destination: Destination | null;
  /** Identification only. Never matched against a current connection to infer sameness. */
  readonly endpoint: string;
  readonly scope: UnfinishedScope;
  /** Latest local activity, for ordering and for the card's "when". */
  readonly activityAt: number;
  readonly sending: boolean;
  /** What the server created, where that is known. */
  readonly server: { readonly id: number; readonly revision: number } | null;
  readonly withdrawn: WithdrawnReason | null;
  readonly actions: readonly UnfinishedAction[];
}

/**
 * The fixed order the design freezes, with the two states it does not name slotted deterministically.
 *
 * The brief orders the grid "a save with no answer, then a refused save, then drafts". A success
 * this phone could not record is placed above a refusal because it is the only row whose evidence
 * can be lost - the result is held in memory until the write lands - and a remainder is placed last
 * because the note it belongs to is already on the server and nothing is waiting on a decision.
 */
const GROUP = {
  unresolved: 0,
  unresolved_withdrawn: 0,
  inconsistent: 0,
  unrecorded_success: 1,
  refused: 2,
  draft: 3,
  remainder: 4,
  // Last, because nothing can be done about one here and nothing is waiting on a decision.
  unusable: 5,
} as const satisfies Record<UnfinishedStatus, number>;

const EMPTY_DOCUMENT = canonicalJson(createEmptyDocument());

/**
 * Whether a draft still holds writing. An acknowledgement empties the fields it cleared.
 *
 * Exported because the composer asks exactly this to decide whether its status says "newer writing
 * kept on this phone", and a recovery list and a screen disagreeing about whether a note still holds
 * something would be the same record described two ways. Every authored field is in it, tags
 * included - the acknowledgement clears all four, so a non-empty one means writing since the
 * creation.
 */
export const hasWriting = (draft: NoteDraftRecord): boolean =>
  draft.title !== '' ||
  draft.description !== '' ||
  draft.tags.length > 0 ||
  canonicalJson(draft.document) !== EMPTY_DOCUMENT;

const withdrawnFrom = (standing: Standing): WithdrawnReason | null => {
  if (standing.kind !== 'blocked') return null;
  if (standing.reason === 'unresolved_unsendable') return standing.cause ?? null;
  if (standing.reason !== 'unresolved_ineligible') return null;

  return standing.attempt?.clockAnomaly === true ? 'clock_anomaly' : 'window_ended';
};

/**
 * What a draft is, from its standing and whether anything is left written in it.
 *
 * `blocked: 'created'` is the one that needs the second question. It covers both the ordinary end of
 * a successful save - content cleared, nothing left to show - and a creation that landed while newer
 * writing existed. They are the same standing and completely different rows.
 */
const statusOf = (draft: NoteDraftRecord, standing: Standing): UnfinishedStatus | null => {
  switch (standing.kind) {
    case 'save':
      return 'draft';
    case 'save_replacing':
      return 'refused';
    case 'retry':
      return 'unresolved';
    case 'record_again':
      return 'unrecorded_success';
    case 'blocked':
      if (standing.reason === 'created') {
        // Cleared content under a created draft is a finished note, not an unfinished one. The row
        // stays on disk as the guard that stops a second creation; it is not a card.
        return hasWriting(draft) ? 'remainder' : null;
      }
      if (standing.reason === 'inconsistent') return 'inconsistent';

      return 'unresolved_withdrawn';
  }
};

const actionsFor = (
  status: UnfinishedStatus,
  scope: UnfinishedScope,
  destination: Destination | null,
): readonly UnfinishedAction[] => {
  // A row this build cannot open has nothing to offer: the owner never adopted it, so there is no
  // draft to open, copy or discard, and migrating it is the one thing that is forbidden outright.
  if (status === 'unusable') return [];
  // A connection that is not the current one can offer only what needs no server and no id from
  // one. Copying makes a fresh draft under the current connection with no destination; discarding
  // removes local writing. Nothing rebinds, resends, or opens a composer whose Save could never be
  // admitted.
  if (scope !== 'current') return ['copy', 'discard'];

  const lookIn: readonly UnfinishedAction[] = destination === null ? [] : ['look_in'];

  switch (status) {
    case 'draft':
    case 'refused':
      return ['open', 'discard'];
    case 'unresolved':
    case 'unresolved_withdrawn':
    case 'inconsistent':
      return ['open', ...lookIn, 'copy', 'discard'];
    case 'unrecorded_success':
      return ['open', 'record_again', ...lookIn, 'discard'];
    case 'remainder':
      return ['open', ...lookIn, 'copy', 'discard'];
  }
};

export interface UnfinishedInput {
  readonly drafts: readonly NoteDraftRecord[];
  /** Retained rows this build cannot open. Reported, never counted as nothing. */
  readonly unusableDrafts?: readonly UnusableDraft[] | undefined;
  readonly attempts: readonly NoteAttemptRecord[];
  readonly unsaved: Readonly<Record<string, AcknowledgedNote>>;
  readonly sending: readonly string[];
  /** The owner's answer for one draft. Never re-derived here. */
  readonly standingFor: (draftId: string) => Standing | null;
  /** The connection the app is working under, or null when there is none. */
  readonly connectionId: string | null;
}

/**
 * Every unfinished note, most pressing first.
 *
 * Within a group, the latest local activity leads and the identifier breaks ties, so the list does
 * not reorder itself between two renders that read the same rows.
 */
export const unfinishedNotes = (input: UnfinishedInput): readonly UnfinishedNote[] => {
  const rows: UnfinishedNote[] = [];

  for (const draft of input.drafts) {
    const standing = input.standingFor(draft.draftId);

    if (standing === null) continue;

    const status = statusOf(draft, standing);

    if (status === null) continue;

    const attempt = newestAttempt(input.attempts, draft.draftId);
    const scope = draft.connectionId === input.connectionId ? 'current' : 'retired';
    const held = attempt === null ? undefined : input.unsaved[attempt.attemptId];
    const acknowledged = attempt?.acknowledged ?? held ?? null;

    rows.push({
      key: `draft:${draft.draftId}`,
      draftId: draft.draftId,
      attemptId: attempt?.attemptId ?? null,
      status,
      group: GROUP[status],
      title: draft.title,
      description: draft.description,
      destination: draft.destination ?? attempt?.destination ?? null,
      endpoint: draft.endpoint,
      scope,
      activityAt: Math.max(draft.updatedAt, attempt?.observedAt ?? 0),
      sending: attempt !== null && input.sending.includes(attempt.attemptId),
      server:
        draft.serverNodeId === null
          ? acknowledged === null
            ? null
            : { id: acknowledged.id, revision: acknowledged.revision }
          : { id: draft.serverNodeId, revision: draft.serverRevision ?? 0 },
      withdrawn: withdrawnFrom(standing),
      actions: actionsFor(status, scope, draft.destination ?? attempt?.destination ?? null),
    });
  }

  for (const draft of input.unusableDrafts ?? []) {
    // Everything known about it, and nothing invented. A row whose columns cannot be read may have
    // no connection and no title, and saying "Untitled note" about one is the card's business, not
    // this projection's.
    rows.push({
      key: `unusable:${draft.draftId}`,
      draftId: null,
      attemptId: null,
      status: 'unusable',
      group: GROUP.unusable,
      problem: draft.problem,
      title: draft.title ?? '',
      description: '',
      destination: null,
      endpoint: draft.endpoint ?? '',
      // Three answers, not two. A row with no readable connection belongs to no heading this screen
      // can honestly write.
      scope: scopeOf(draft.connectionId, input.connectionId),
      // Nothing about it is known to have happened at a time this build can read.
      activityAt: 0,
      sending: false,
      server: null,
      withdrawn: null,
      // Deliberately empty. `discardDraft` works over drafts the owner adopted, and this is not one;
      // offering a discard would be a control that answers no, and migrating it is forbidden.
      actions: [],
    });
  }

  for (const attempt of orphanAttempts(input)) {
    const scope = attempt.connectionId === input.connectionId ? 'current' : 'retired';
    const held = input.unsaved[attempt.attemptId];
    const logical = logicalStateOf(factsOf(attempt), held !== undefined);
    const status: UnfinishedStatus =
      logical === 'created'
        ? attempt.acknowledged === null
          ? 'unrecorded_success'
          : 'inconsistent'
        : logical === 'refused'
          ? 'refused'
          : 'unresolved_withdrawn';

    rows.push({
      key: `attempt:${attempt.attemptId}`,
      draftId: null,
      attemptId: attempt.attemptId,
      status,
      group: GROUP[status],
      title: attempt.title,
      description: '',
      destination: attempt.destination,
      endpoint: attempt.endpoint,
      scope,
      activityAt: attempt.observedAt,
      sending: input.sending.includes(attempt.attemptId),
      server:
        attempt.acknowledged === null
          ? held === undefined
            ? null
            : { id: held.id, revision: held.revision }
          : { id: attempt.acknowledged.id, revision: attempt.acknowledged.revision },
      withdrawn: null,
      // There is no draft behind this, so there is nothing to open, copy or discard. What is left is
      // looking where it was going, and - for a success already written down - saying it has been
      // seen. Everything else is retained and reported, because absence cannot prove non-dispatch.
      actions:
        scope === 'retired'
          ? []
          : attempt.acknowledged !== null
            ? ['look_in', 'dismiss']
            : ['look_in'],
    });
  }

  return rows.sort(
    (left, right) =>
      left.group - right.group ||
      right.activityAt - left.activityAt ||
      left.key.localeCompare(right.key),
  );
};

/**
 * Which connection a record belongs to.
 *
 * A record whose connection could not be read is `unknown`. Calling it `retired` would be a claim
 * that it came from somewhere else, which is exactly the thing not knowing means we cannot say.
 */
const scopeOf = (recorded: string | null, current: string | null): UnfinishedScope => {
  if (recorded === null) return 'unknown';

  return recorded === current ? 'current' : 'retired';
};

/**
 * Attempts whose draft is gone.
 *
 * A draft can be discarded while its attempt survives, because discarding writing cannot un-ask a
 * question. Those attempts have to stay visible somewhere or the only evidence that something may
 * exist on the server would be a row nothing reads.
 */
const orphanAttempts = (input: UnfinishedInput): readonly NoteAttemptRecord[] =>
  input.attempts.filter(
    (attempt) => !input.drafts.some((draft) => draft.draftId === attempt.draftId),
  );

/** A success the person has not been told about yet. */
export interface SaveReceipt {
  readonly attemptId: string;
  readonly destination: Destination;
  readonly note: AcknowledgedNote;
}

/**
 * Receipts waiting to be shown, oldest first.
 *
 * Only for the connection the app is working under: a success on a server this device has since
 * left is not news for the current Home, and it stays in recovery with its own explicit dismissal.
 * The order is total so two renders of the same rows queue them the same way.
 */
export const pendingReceipts = (
  attempts: readonly NoteAttemptRecord[],
  connectionId: string | null,
): readonly SaveReceipt[] =>
  attempts
    .filter((attempt) => attempt.acknowledged !== null && attempt.connectionId === connectionId)
    .sort(
      (left, right) =>
        left.firstDispatchAt - right.firstDispatchAt ||
        left.attemptId.localeCompare(right.attemptId),
    )
    .map((attempt) => ({
      attemptId: attempt.attemptId,
      destination: attempt.destination,
      // Non-null by the filter above; narrowed here rather than asserted at the call site.
      note: attempt.acknowledged as AcknowledgedNote,
    }));
