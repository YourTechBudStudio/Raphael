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

import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';

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
        return { text: serverStatus(standing.revision), tone: 'quiet' };
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
