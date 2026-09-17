/**
 * Every change on this phone that the server has not been given, as something a list can draw.
 *
 * `unfinished.ts` for edits, and pure for the same reason: the ordering and the action sets are
 * testable without a database, and the certainty question stays with the owner. This derives from
 * `standingFor` rather than from state strings, so nothing here forms a second opinion about what a
 * record means.
 *
 * Two rules carry the weight.
 *
 * **Everything is unfinished except a `synced` record.** A settled record is deleted when the editor
 * leaves, so the only synced records are ones with an editor attached right now - and those still
 * belong on the list while they exist, because a person who navigated away mid-save must be able to
 * find what they were doing.
 *
 * **An unusable row is always listed.** A row this build cannot open is the one thing that must never
 * be invisible, so it is listed with `discard` as its only action - by key, without ever being parsed.
 *
 * **Nothing unfinished is drawn on Home as a card.** Home carries one count; Recovery carries this
 * list, transient rows included. There is no `onHome` projection, deliberately.
 */

import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';

import type { EditStanding } from './edit-policy.ts';
import {
  editKeyOf,
  type EditProblem,
  type EditRefusal,
  type EntityEditRecord,
  type UnusableEdit,
} from './edit-types.ts';

export interface UnfinishedEdit {
  /** Namespaced by its producer, so an edit and a draft numbered the same are different cards. */
  readonly key: string;
  readonly editKey: string;
  readonly nodeId: number;
  /** Null only for a row whose columns could not be read. Never inferred. */
  readonly nodeType: NodeType | null;
  /**
   * What the entity is, for the surface that has to name its ID field. Null on an unusable row.
   *
   * Carried rather than re-derived because `idLabelOf` needs it and nothing outside the record knows
   * it: a card that guessed would call a project's ID a note's.
   */
  readonly kind: ResourceKind | null;
  /** Empty when the column could not be read. Empty is also a legitimate title. */
  readonly title: string;
  /** `'unusable'` for a retained row this build cannot open. */
  readonly standing: EditStanding['kind'] | 'unusable';
  /**
   * The refusal behind a `refused` row, copied straight off the record. Null everywhere else, and
   * null on a `refused` row whose diagnostic could not be read.
   *
   * Carried because the sentence a list draws for a refusal has to say *why* - and a projection that
   * kept only `standing.kind` would leave every refused row reading the sentence that exists for "the
   * refusal could not be parsed", which is a different fact about a different failure.
   */
  readonly refusal: EditRefusal | null;
  readonly problem?: EditProblem | undefined;
  readonly endpoint: string | null;
  readonly scope: 'current' | 'retired';
  readonly activityAt: number;
  readonly actions: readonly ('open' | 'discard')[];
}

/**
 * Most pressing first, with the two ends of the list argued rather than assumed.
 *
 * `unusable` leads because it is the only row nothing will ever resolve on its own. `saving` trails
 * the ordinary states because a request in the air needs no decision from anyone - it is the one row
 * that is actively getting better while it is looked at.
 *
 * Exported because it is the **only runtime enumeration of the standing union**, and the `satisfies`
 * below is what keeps it one: adding a standing that is not listed here fails to compile. A test that
 * needs to walk every standing walks this rather than restating the list, which would be a second
 * copy free to fall behind. Deliberately not re-exported from `index.ts`; it is not package-public.
 */
export const STANDING_ORDER = {
  unusable: 0,
  conflicted: 1,
  refused: 2,
  unconfirmed: 3,
  offline: 4,
  pending: 5,
  saving: 6,
  // Present for totality. A synced record is filtered out above, except while an editor holds it.
  synced: 7,
} as const satisfies Record<EditStanding['kind'] | 'unusable', number>;

/** Whether a row belongs to the connection the app is working under right now. */
const scopeOf = (connectionId: string, current: string | null): 'current' | 'retired' =>
  connectionId === current ? 'current' : 'retired';

export interface UnfinishedEditsInput {
  readonly edits: readonly EntityEditRecord[];
  /** Retained rows this build cannot open. Reported, never counted as nothing. */
  readonly unusableEdits?: readonly UnusableEdit[] | undefined;
  /**
   * The owner's answer for one record. Never re-derived here.
   *
   * There is no separate `sending` list: `editStandingOf` already consumes it to tell `saving` from
   * `unconfirmed`, and this projection publishes the standing rather than the flag. A second copy here
   * would be a second authority on the same question.
   */
  readonly standingFor: (editKey: string) => EditStanding | null;
  /** The connection the app is working under, or null when there is none. */
  readonly connectionId: string | null;
}

export const unfinishedEdits = (input: UnfinishedEditsInput): readonly UnfinishedEdit[] => {
  const rows: UnfinishedEdit[] = [];

  for (const record of input.edits) {
    const editKey = editKeyOf(record.key);
    const standing = input.standingFor(editKey);

    // No standing means the owner is not holding this record, so nothing here can say what it means.
    if (standing === null) continue;
    // Everything on the server, with nothing unsent. Not unfinished.
    if (standing.kind === 'synced') continue;

    rows.push({
      key: `edit:${editKey}`,
      editKey,
      nodeId: record.key.nodeId,
      nodeType: record.nodeType,
      kind: record.kind,
      title: record.content.title,
      standing: standing.kind,
      refusal: standing.kind === 'refused' ? standing.refusal : null,
      endpoint: record.endpoint,
      scope: scopeOf(record.key.connectionId, input.connectionId),
      activityAt: record.updatedAt,
      // A retired connection can offer only what needs no server and no id from one, which is the
      // rule `unfinished.ts`'s `actionsFor` already applies to drafts. Here it is narrower than
      // there, because there is nothing to copy: an edit is addressed by `(connectionId, nodeId)`
      // and a node id is not portable between servers, so opening this row under the current
      // connection would not reopen it - it would seed a fresh record over whatever entity happens
      // to hold that number on the server the phone is talking to now.
      actions:
        scopeOf(record.key.connectionId, input.connectionId) === 'current'
          ? ['open', 'discard']
          : ['discard'],
    });
  }

  for (const unusable of input.unusableEdits ?? []) {
    const editKey = editKeyOf(unusable.key);

    rows.push({
      key: `unusable-edit:${editKey}`,
      editKey,
      nodeId: unusable.key.nodeId,
      nodeType: unusable.nodeType,
      // Nothing about an unopenable row is known well enough to name what its ID field is called.
      kind: null,
      // Nothing invented: a row whose columns cannot be read may have no title to read either, and
      // saying "Untitled" about one is the card's business, not this projection's.
      title: unusable.title ?? '',
      standing: 'unusable',
      refusal: null,
      problem: unusable.problem,
      endpoint: unusable.endpoint,
      scope: scopeOf(unusable.key.connectionId, input.connectionId),
      // Nothing about it is known to have happened at a time this build can read.
      activityAt: 0,
      // Discard only, and it works by key. Opening it would be a control that answers no, and
      // migrating it is the one thing that is forbidden outright.
      actions: ['discard'],
    });
  }

  // The order is total, so two renders of the same rows never disagree.
  return rows.sort(
    (left, right) =>
      STANDING_ORDER[left.standing] - STANDING_ORDER[right.standing] ||
      right.activityAt - left.activityAt ||
      left.key.localeCompare(right.key),
  );
};
