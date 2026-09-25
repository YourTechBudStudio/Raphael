/**
 * What the editor says about one record, and the one thing it may offer.
 *
 * `composer.ts` for existing entities, and pure for the same reason: the precedence is a correctness
 * rule, not a layout choice. **Protection outranks everything**, because a screen reporting "Saving to
 * your server…" over writing this phone could not keep is telling someone their work is safe in the
 * one moment it is not. Below that the server's verdicts outrank what this phone cannot establish,
 * which outranks what it cannot attempt, which outranks the ordinary states - and `edit-policy.ts`
 * has already applied that half.
 *
 * The protection question is not restated here: `problemOf` is imported from `composer.ts` and called.
 * Two copies of that rule is exactly how two screens end up disagreeing about whether writing is safe.
 *
 * **The alert colour appears once.** While the conflict notice is showing, the status line still
 * states the fact but goes quiet, because the band carries the alert and a person should not have to
 * work out whether two red things are one problem or two. Every other alert standing keeps its tone on
 * the status line, since nothing else on screen says it.
 *
 * **The slug is called the ID.** "Slug" is the contract's word, the store's word and the CLI's word,
 * and it appears in no sentence here: the interface says "note ID", "area ID" or "project ID".
 */

import type { ClientFailure } from '@raphael/client';
import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';

import { archivedRefusalSentence } from '../lifecycle/copy.ts';
import {
  KEPT_ON_PHONE,
  PROTECTION_COPY,
  SAVING_STATUS,
  problemOf,
  serverStatus,
  type ComposerStatus,
  type ProtectionInput,
  type ProtectionProblem,
} from './composer.ts';
import type { EditLocation, LifecycleNotSentReason, MoveNotSentReason } from './edit-owner.ts';
import type { EditStanding } from './edit-policy.ts';
import type { EditProblem, EditRefusal } from './edit-types.ts';

export const CONFLICTED_STATUS =
  'Changed on your server since you opened it · your changes are kept on this phone';

/**
 * The band's one sentence. The status line states the same fact in fewer words; this is the one that
 * has room to say what happens next, which is that nothing was overwritten.
 */
export const CONFLICT_NOTICE =
  'This changed on your server after you opened it. Your changes are still here on this phone, and nothing on your server was overwritten.';

export const UNCONFIRMED_EDIT_STATUS = 'Last change not confirmed · checking your server';
export const OFFLINE_STATUS = `${KEPT_ON_PHONE} · not connected to your server`;
export const PENDING_STATUS = `${KEPT_ON_PHONE} · saving soon`;

/** What the ID field is called, by what is being edited. Never "slug". */
export const idLabelOf = (nodeType: NodeType, kind: ResourceKind | null): string => {
  if (nodeType === 'area') return 'area ID';
  if (nodeType === 'project') return 'project ID';

  return kind === 'note' ? 'note ID' : 'ID';
};

/**
 * What the Details chip says, and what it is called out loud.
 *
 * Here rather than in the component for the reason `idLabelOf` is here: this is the one place that
 * turns a stored `slug` into a word a person reads, and a screen that composed its own label would be
 * a second place where "slug" could reach an interface. The label is deliberately terse - it is a
 * chip - while the spoken form names what each part is, because "autosave-loop-notes, 3 tags" read
 * aloud says nothing about what the first half is.
 *
 * **A null slug is the creation screen**, where there is no ID because the server has not derived one
 * from the title yet. The chip is then about tags alone, and it says so rather than showing a blank
 * where an ID would be. It is composed here and not on that screen for the same reason as everything
 * above: one place decides what this chip is called.
 */
export interface DetailsChip {
  readonly label: string;
  readonly spoken: string;
  readonly hint: string;
}

export const detailsChip = (input: {
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  /** Null on a note that does not exist yet. */
  readonly slug: string | null;
  readonly tagCount: number;
}): DetailsChip => {
  const idLabel = idLabelOf(input.nodeType, input.kind);
  const tags = `${String(input.tagCount)} ${input.tagCount === 1 ? 'tag' : 'tags'}`;

  if (input.slug === null) {
    return {
      label: input.tagCount === 0 ? 'Tags' : tags,
      spoken: input.tagCount === 0 ? 'Details: no tags' : `Details: ${tags}`,
      hint: 'Adds tags to this note',
    };
  }

  return {
    label: input.tagCount === 0 ? input.slug : `${input.slug} · ${tags}`,
    spoken: `Details: ${idLabel} ${input.slug}, ${tags}`,
    hint: `Changes the ${idLabel} and tags`,
  };
};

/**
 * Why the server refused, in the distinctions that change what someone should do next.
 *
 * A closed map rather than the server's own sentence: the codes are a contract and the words are this
 * app's. Anything not in the map falls back to the code itself, which is worse to read and better than
 * inventing a cause - a refusal nobody anticipated must not be described as one that was.
 */
const refusalReason = (refusal: EditRefusal, idLabel: string): string => {
  if (refusal.code === 'slug_conflict') return `that ${idLabel} is already used`;
  if (refusal.code === 'node_not_found') return 'it no longer exists on your server';
  if (refusal.code === 'node_archived') return 'it is archived';
  if (refusal.code === 'unsupported_content') {
    return 'the body has something your server does not support';
  }
  if (refusal.code === 'invalid_input') {
    if (refusal.reason === 'title_required') return 'a title is required';
    if (refusal.reason === 'tags_too_many') return 'too many tags';
    if (refusal.field === 'slug') return `that ${idLabel} is not valid`;
  }

  return refusal.code;
};

/**
 * The refused sentence.
 *
 * A null refusal is a legitimate reading, not a contradiction: the record's `syncState` carries the
 * refusal independently, and the stored diagnostic may be one this build cannot parse. The sentence
 * then says what is certainly true and stops, rather than guessing at a cause.
 */
export const refusedStatus = (refusal: EditRefusal | null, idLabel: string): string =>
  refusal === null
    ? 'Your server refused the last change · your changes are kept on this phone'
    : `Your server refused the last change · ${refusalReason(refusal, idLabel)}`;

/**
 * Why a retained edit cannot be opened here.
 *
 * `copy.ts`'s three sentences for the second table, and generalized past "note" because containers are
 * edited by the same editor. Read by the unavailable screen and the recovery card alike, so the two
 * cannot describe the same row differently.
 */
export const EDIT_PROBLEM_COPY: Record<EditProblem, string> = {
  unsupported_content_schema:
    'These changes were written by a different version of Raphael, and this one cannot open them. They are kept exactly as they are; a newer version will be able to read them.',
  unusable_body:
    'These changes are not something this version of Raphael can open. They are kept exactly as they are rather than changed or removed.',
  unreadable_row:
    'Raphael could not read this record of unsent changes on this phone. It is kept exactly as it is rather than changed or removed.',
};

/**
 * What a list says about one edit, in a sentence rather than a status line.
 *
 * Here, beside the status line it parallels, because the rule this module exists for is that **no
 * sentence about an edit is composed anywhere else** - a card and the editor describing the same
 * record differently is exactly how someone concludes they have two problems.
 *
 * It is not the status line reused, and two of those would be false here.
 *
 * `UNCONFIRMED_EDIT_STATUS` says "checking your server", which is true in the editor - the owner
 * reconciles in `open()` - and is a claim about work in progress on a screen where no editor is
 * attached and nothing is running. `PENDING_STATUS` says "saving soon", which is true only while an
 * editor holds the record with its debounce armed; on a list of things nobody is holding it is a
 * promise the phone is not keeping. So `unconfirmed` says what is actually known and what would
 * settle it, and the two waiting states say the one fact that is true of both: it is here, it is not
 * there.
 *
 * `conflicted`, `refused` and an unusable row reuse the sentences that already exist, which is the
 * whole point - `CONFLICT_NOTICE` was already one fact said twice for two surfaces. `unusable` is in
 * this function rather than left to the caller for the same reason everything else is: a card that
 * reached for `EDIT_PROBLEM_COPY` itself would be one branch of this decision living somewhere else.
 *
 * **Total on purpose**, `synced` included. `unfinishedEdits` filters synced rows out, but a function
 * with a hole in it renders a blank card the day that filter changes.
 */
export const editCardSentence = (input: {
  readonly standing: EditStanding['kind'] | 'unusable';
  readonly refusal: EditRefusal | null;
  /** Read only for an unusable row, where it is the whole sentence. */
  readonly problem?: EditProblem | undefined;
  /**
   * What the row is, for the one arm that names an ID field. Null is a row whose type could not be
   * read - which is an unusable row, whose sentence names no field at all - so no caller has to
   * invent a type to satisfy this.
   */
  readonly nodeType: NodeType | null;
  readonly kind: ResourceKind | null;
}): string => {
  switch (input.standing) {
    case 'unusable':
      // A row whose columns could not be read still has a reason, and the default is the one that
      // claims least: the record could not be read at all.
      return EDIT_PROBLEM_COPY[input.problem ?? 'unreadable_row'];
    case 'conflicted':
      return CONFLICT_NOTICE;
    case 'refused':
      return refusedStatus(input.refusal, idLabelOf(input.nodeType ?? 'resource', input.kind));
    case 'unconfirmed':
      return 'The last change may or may not have reached your server. Open it to check.';
    case 'offline':
    case 'pending':
      return 'Changes made here are kept on this phone and have not reached your server.';
    case 'saving':
      return 'These changes are on their way to your server.';
    case 'synced':
      return 'Everything written here is on your server.';
  }
};

/**
 * The heading over the edits on the recovery screen.
 *
 * It names the fact rather than the mechanism - not "unsent updates" or "pending edits", which
 * describe a queue. What a person needs to know is where their writing is and where it is not.
 */
export const EDITS_HEADING = 'Edits not on your server';

/**
 * The word for what is being edited, as a list's eyebrow says it.
 *
 * Here with `idLabelOf` because it is the same decision one step earlier: that module turns a node
 * type into the noun a person reads. A row whose columns could not be read has no type to read, and
 * "Changes" is what is certainly true of it - inventing "Note" would be naming the one fact missing.
 */
export const editKindWord = (nodeType: NodeType | null, kind: ResourceKind | null): string => {
  if (nodeType === 'area') return 'Area';
  if (nodeType === 'project') return 'Project';
  if (nodeType === 'resource') return kind === 'note' ? 'Note' : 'Item';

  return 'Changes';
};

/**
 * Whether a row's eyebrow is said in the alert colour.
 *
 * The three standings a person has to decide something about, plus the row that can never resolve
 * itself. Waiting and sending are not problems, and colouring them would leave the colour meaning
 * "unfinished" rather than "this one needs you". Never the only cue: every standing is also a
 * sentence.
 */
export const isAlarmingEdit = (standing: EditStanding['kind'] | 'unusable'): boolean =>
  standing === 'conflicted' ||
  standing === 'refused' ||
  standing === 'unconfirmed' ||
  standing === 'unusable';

/**
 * The one confirmation for throwing local changes away, wherever it is offered.
 *
 * One prompt rather than one per standing, because the fact it has to establish is the same in every
 * one of them and it is the fact people get wrong: **this removes what is on the phone and does not
 * touch the server.** A conflict is the case that makes it matter - discarding there is the only
 * offered action, and someone who read it as "discard the note" would be refusing to click the one
 * control that resolves their editor.
 */
export const EDIT_DISCARD_PROMPT = {
  title: 'Discard your changes?',
  message: 'The changes kept on this phone will be removed. What is on your server stays as it is.',
  keepLabel: 'Keep them',
} as const;

export interface EditComposerInput extends ProtectionInput {
  readonly standing: EditStanding;
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  /** The last acknowledged move, said on the status line while it still describes the record. */
  readonly moved?: MovedNotice | null | undefined;
}

export interface EditComposerView {
  readonly status: ComposerStatus;
  /** The conflict band, or nothing. The one state this screen says with more than a status line. */
  readonly notice: 'conflict' | null;
  /** A barrier is settling: the fields and the toolbar are disabled. Never merely "saving". */
  readonly locked: boolean;
  /** Present when the writing on screen is not safely on this phone. */
  readonly problem: ProtectionProblem | null;
}

export const editComposerView = (input: EditComposerInput): EditComposerView => {
  const problem = problemOf(input);
  const { standing } = input;
  const idLabel = idLabelOf(input.nodeType, input.kind);

  // The band shows only when nothing outranks it. A protection problem is about writing that is not
  // safe on this phone at all, which is a worse fact than a server having moved on.
  const notice = problem === null && standing.kind === 'conflicted' ? 'conflict' : null;

  const status = ((): ComposerStatus => {
    // Protection first, always. Everything below it is a statement about a server, and none of them is
    // worth saying over "what you have written is not safe here".
    if (problem !== null) return { text: PROTECTION_COPY[problem], tone: 'alert' };

    switch (standing.kind) {
      case 'conflicted':
        // Quiet exactly when the band is carrying the alert, which by the branch above is always.
        return { text: CONFLICTED_STATUS, tone: 'quiet' };
      case 'refused':
        return { text: refusedStatus(standing.refusal, idLabel), tone: 'alert' };
      case 'unconfirmed':
        return { text: UNCONFIRMED_EDIT_STATUS, tone: 'alert' };
      case 'offline':
        return { text: OFFLINE_STATUS, tone: 'alert' };
      case 'saving':
        return { text: SAVING_STATUS, tone: 'quiet' };
      case 'pending':
        return { text: PENDING_STATUS, tone: 'quiet' };
      case 'synced':
        return {
          text:
            input.moved != null && movedNoticeHolds(input.moved, standing)
              ? movedStatus(input.moved.place, standing.revision)
              : serverStatus(standing.revision),
          tone: 'quiet',
        };
    }
  })();

  return {
    status,
    notice,
    // A barrier settling, never a request in flight: an existing entity autosaves, so locking the
    // fields whenever something was in the air would make the editor unusable while it worked.
    locked: input.protection?.locked ?? false,
    problem,
  };
};

/*
 * Moving. Every sentence the move control, its sheet and the status line can say about a move.
 *
 * On this phone a move never changes the ID: the sheet offers places and nothing else, and changing
 * the ID stays in Details as an ordinary edit. So the one refusal a place cannot repair, an ID already
 * used where this is going, points there.
 */

export const MOVE_SHEET_TITLE = 'Where should this go?';
export const moveSheetSubtitle = (current: string): string =>
  `In ${current} now. Tap a place to move this there.`;
export const moveBusySubtitle = (place: string): string => `Moving to ${place}…`;

/** The root, as a row. "Areas" is what the eyebrow says for a root-level area. */
export const MOVE_ROOT_LABEL = 'Areas';
export const MOVE_ROOT_TAG = 'Top level';
export const MOVE_ROOT_HINT = 'Moves this area to the top level';
export const MOVE_ROOT_CURRENT_HINT = 'It is here now. Closes this sheet';
/** The root, as a destination in a sentence. */
export const MOVE_ROOT_PLACE = 'the top level';
/** A destination the tree this phone read cannot name. What is certainly true of it. */
export const MOVE_UNNAMED_PLACE = 'its new place';

export const MOVE_EYEBROW_HINT = 'Moves this somewhere else';
export const MOVE_LOCKED_HINT = 'Comes back once the writing is protected';
export const MOVE_UNCONFIRMED_HINT = 'Comes back once your server has answered about the last move';
/** Why the sheet cannot be closed while a move is out. The same words as the editor's own Close. */
export const MOVE_CLOSE_WAITING_HINT = 'Available once your server has answered';

export const MOVE_TREE_FAILED =
  'Unable to load areas and projects. Where this is filed has not changed.';
export const MOVE_TREE_NO_MATCH = 'Nothing here matches that. Try a shorter word.';
export const MOVE_TREE_EMPTY = 'No area or project here can hold this.';

export const movedStatus = (place: string, revision: number): string =>
  `Moved to ${place} · revision ${String(revision)}`;

/**
 * An acknowledged move, as the status line says it.
 *
 * `revision` is the acknowledged record's own base revision, never an increment: a server that had
 * nothing to change answers at the revision it already held. `place` is named from a current reading
 * each time the line is drawn, by the screen, so it cannot name a destination that has since been
 * renamed while the eyebrow names it correctly.
 */
export interface MovedNotice {
  readonly place: string;
  readonly revision: number;
}

/**
 * The moved notice for the status line, with its place named from the current reading.
 *
 * `movedTo` is where the move went, held without a name. `currentName` is the last segment the
 * eyebrow draws now. The eyebrow follows the owner's location, so while that is still where the move
 * went the two name the same place, renamed or not. Otherwise the line claims no name it cannot back.
 */
export const movedNotice = (
  movedTo: { readonly parentId: number | null; readonly revision: number } | null,
  location: EditLocation,
  currentName: string | undefined,
): MovedNotice | null => {
  if (movedTo === null) return null;

  const here = location.kind === 'known' && location.parentId === movedTo.parentId;
  const place = movedTo.parentId === null ? MOVE_ROOT_PLACE : here ? currentName : undefined;

  return { revision: movedTo.revision, place: place ?? MOVE_UNNAMED_PLACE };
};

/**
 * Whether the notice still describes the record: synced at exactly the revision the move left.
 *
 * Anything else - an edit waiting, a send, a verdict - is the standing changing, and from then on the
 * ordinary status line speaks. The screen drops the notice at that point, so it cannot come back if
 * the record later reads synced at the same revision again.
 */
export const movedNoticeHolds = (
  notice: { readonly revision: number },
  standing: EditStanding,
): boolean => standing.kind === 'synced' && standing.revision === notice.revision;

/**
 * The eyebrow's Move control, or null where the eyebrow stays a label.
 *
 * Null for an unknown location: a phone that could not read where something is cannot judge a move
 * from there. Null too for an entity archived by a cause of its own, which the server refuses to move
 * until that is restored; archived only through a container above, it keeps the control, because
 * moving somewhere active is exactly what undoes that. Disabled while a barrier is settling or the
 * screen is leaving, and while the last move is unanswered, and each says when it comes back.
 */
export const moveControl = (input: {
  readonly locationKnown: boolean;
  readonly archivedDirectly: boolean;
  readonly locked: boolean;
  readonly leaving: boolean;
  readonly moveInflight: boolean;
}): { readonly disabled: boolean; readonly hint: string } | null => {
  if (!input.locationKnown || input.archivedDirectly) return null;
  if (input.moveInflight) return { disabled: true, hint: MOVE_UNCONFIRMED_HINT };
  if (input.locked || input.leaving) return { disabled: true, hint: MOVE_LOCKED_HINT };

  return { disabled: false, hint: MOVE_EYEBROW_HINT };
};

/** Row copy for the move picker, in the note picker's grammar. `word` is `editKindWord`, lowercased. */
export const moveRowCopy = (word: string) => ({
  hint: (title: string) => `Moves this ${word} into ${title}`,
  chosen: (title: string) => `${title} is where this goes`,
});

/** Why a move was not sent, by the owner's reason. */
export const moveNotSentSentence = (reason: MoveNotSentReason): string => {
  switch (reason) {
    case 'unsent_writing':
      return 'Your changes need to reach your server before this can move.';
    case 'no_session':
      return 'Not connected to your server, so this cannot move right now.';
    case 'conflicted':
      return CONFLICT_NOTICE;
    case 'refused':
      return 'Your server refused the last change. Fix that before moving this.';
    case 'unconfirmed':
      return 'The last change has not been confirmed by your server yet. Try again once it has.';
    case 'unknown_location':
      return 'Where this is filed could not be read from your server, so it cannot move yet.';
  }
};

/**
 * A failed archive or restore beside writing that is not on the server, in the status line's two
 * lines. The save status is replaced by the one phrase that matters here - the writing is kept on this
 * phone - so neither fact can be cut off; the refusal's detail returns once the line clears.
 */
export const lifecycleBesideKept = (brief: string): string =>
  `${brief} · ${KEPT_ON_PHONE.toLowerCase()}`;

/**
 * Why an archive or restore was not sent, by the owner's reason.
 *
 * Only about the request. Nothing here says whether the entity is archived - one archived through a
 * container above stays archived, and the status line already says so - or whether writing the settle
 * step sent was saved, which the edit standing reports on its own.
 */
export const lifecycleNotSentSentence = (
  verb: 'archive' | 'restore',
  reason: LifecycleNotSentReason,
): string => {
  switch (reason) {
    case 'no_session':
      return `Not connected to your server, so the ${verb} request was not sent.`;
    case 'unconfirmed':
      return `The last change has not been confirmed by your server yet, so the ${verb} request was not sent. Try again once it has.`;
    case 'unsent_writing':
      return `Your changes need to reach your server first, so the ${verb} request was not sent.`;
    case 'unread':
      return `Raphael could not read this from your server, so the ${verb} request was not sent.`;
  }
};

/**
 * A definite refusal of a move, from the bounded code and reason vocabulary the client projects.
 *
 * `place` is where the person tapped and `slug` the ID this keeps, which is what a collision is
 * about: the sheet cannot change the ID, so the sentence says where it can be changed.
 */
export const moveRefusalSentence = (
  failure: ClientFailure,
  context: { readonly idLabel: string; readonly place: string; readonly slug: string },
): string => {
  if (failure.kind !== 'api_error') return failure.message;

  const { code } = failure.error;
  const { idLabel, place, slug } = context;

  if (code === 'invalid_parent') {
    return failure.details.reason === 'cycle'
      ? 'Something cannot move inside itself.'
      : 'That place cannot hold this.';
  }
  if (code === 'slug_conflict') {
    return `Something in ${place} already uses the ${idLabel} “${slug}”. Change this ${idLabel} in Details, then move it.`;
  }
  if (code === 'node_archived') return archivedRefusalSentence(failure.details);
  if (code === 'node_not_found') {
    // The server says which side is missing, and the advice differs: a missing destination is
    // repaired by choosing another place; a missing target is not something a place can fix.
    return failure.details.field === 'target'
      ? 'This no longer exists on your server, so it cannot be moved.'
      : 'That place no longer exists. Refresh and pick again.';
  }

  return failure.message;
};
