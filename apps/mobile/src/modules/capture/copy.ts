/**
 * What the composer, the editor, the move sheet and Unfinished say.
 *
 * Pure, so the words run under `node --test`. "Slug" appears in no sentence: the interface says
 * "note ID", "area ID" or "project ID".
 */

import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';

export interface StatusLine {
  readonly text: string;
  readonly tone: 'quiet' | 'alert';
}

/** A local write that did not reach SQLite. There is no repair flow; the next write tries again. */
export const NOT_KEPT_STATUS: StatusLine = { text: 'Couldn’t save on this phone', tone: 'alert' };

/* ------------------------------------------------------------------------------------ composer */

/** What stops a draft from saving, first thing first. */
export type DraftProblem = 'destination' | 'writing' | 'slug' | null;

/** Where a new note stands. Only a refusal is said in the error colour: nothing else is wrong. */
export type CreateStanding =
  | { readonly kind: 'draft'; readonly problem: DraftProblem }
  | { readonly kind: 'saving' }
  | { readonly kind: 'retrying' }
  | { readonly kind: 'refused'; readonly message: string };

export const createStatus = (standing: CreateStanding): StatusLine => {
  switch (standing.kind) {
    case 'saving':
      return { text: 'Saving…', tone: 'quiet' };
    case 'retrying':
      return { text: 'Couldn’t save · will retry', tone: 'quiet' };
    case 'refused':
      return { text: `Not saved: ${standing.message}`, tone: 'alert' };
    case 'draft':
      switch (standing.problem) {
        case 'destination':
          return { text: 'Draft · choose where it goes to save', tone: 'quiet' };
        case 'writing':
          return { text: 'Draft · add a title or some writing to save', tone: 'quiet' };
        case 'slug':
          return { text: 'Draft · the title needs a letter or number to save', tone: 'quiet' };
        case null:
          return { text: 'Draft · on this phone', tone: 'quiet' };
      }
  }
};

/** Save retries on its own after a retryable failure, so pressing it then only skips the wait. */
export const saveLabel = (standing: CreateStanding): string => {
  if (standing.kind === 'saving') return 'Saving…';
  if (standing.kind === 'retrying') return 'Try now';
  return 'Save';
};

/** Said on Home after leaving a composer that still holds writing. */
export const KEPT_DRAFT_NOTICE = 'Kept in Unfinished as a draft.';
export const KEPT_RETRYING_NOTICE = 'Kept in Unfinished. It will keep trying.';

export const savedIn = (place: string | null): string =>
  place === null ? 'Saved on your server.' : `Saved in ${place}.`;

/** A chosen destination, named - or honestly not named. */
export interface DestinationName {
  /** `parent / leaf`, with a leading ellipsis when deeper. Null means nothing is chosen. */
  readonly chip: string | null;
  /** The whole path, or null where there is none to speak. */
  readonly spoken: string | null;
  /** Just the leaf, for "Saved in <leaf>". */
  readonly leaf: string | null;
}

export interface DestinationEyebrow {
  readonly label: string;
  readonly spoken: string;
  readonly hint: string;
}

/** The destination row above the title. A chosen place that cannot be named stays chosen. */
export const destinationEyebrow = (name: DestinationName): DestinationEyebrow => {
  const hint = 'Chooses the area or project this note goes in';

  if (name.chip === null) {
    return { label: 'Where does this go?', spoken: 'Choose where this note goes', hint };
  }

  return {
    label: name.chip,
    spoken:
      name.spoken === null
        ? 'Where this note goes, which your server has not named here yet'
        : `Filed in ${name.spoken}`,
    hint,
  };
};

/* -------------------------------------------------------------------------------------- editor */

/** Where an edit to something that exists stands. It autosaves; this is the line beside Close. */
export type EditStanding =
  | { readonly kind: 'saved' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'conflict' };

export const editStatus = (standing: EditStanding): StatusLine => {
  switch (standing.kind) {
    case 'saved':
      return { text: 'Saved', tone: 'quiet' };
    case 'saving':
      return { text: 'Saving…', tone: 'quiet' };
    case 'offline':
      return { text: 'Offline · kept on this phone', tone: 'quiet' };
    case 'waiting':
      return { text: 'Waiting for your server · kept on this phone', tone: 'quiet' };
    case 'refused':
      return { text: `Not saved: ${standing.message}`, tone: 'alert' };
    case 'conflict':
      return { text: 'Changed on your server', tone: 'quiet' };
  }
};

/** Move and archive wait for unsent writing, and say so when pressed for. */
export const UNAVAILABLE_UNTIL_SAVED_HINT = 'Available once your changes are saved';

export const CONFLICT_BAND =
  'This changed on your server while you were editing. Which version stays?';

export const TAKE_SERVERS_PROMPT = {
  title: 'Discard your changes?',
  message: 'Your server’s version replaces what you wrote here.',
  keepLabel: 'Cancel',
  discardLabel: 'Discard mine',
} as const;

export const KEEP_MINE_PROMPT = {
  title: 'Replace the version on your server?',
  message: 'What you wrote here overwrites the changes made on your server.',
  keepLabel: 'Cancel',
  discardLabel: 'Replace',
} as const;

/** What the ID field is called, by what is being edited. Never "slug". */
export const idLabelOf = (nodeType: NodeType, kind: ResourceKind | null): string => {
  if (nodeType === 'area') return 'area ID';
  if (nodeType === 'project') return 'project ID';

  return kind === 'note' ? 'note ID' : 'ID';
};

export const editKindWord = (nodeType: NodeType, kind: ResourceKind | null): string => {
  if (nodeType === 'area') return 'Area';
  if (nodeType === 'project') return 'Project';

  return kind === 'note' ? 'Note' : 'Item';
};

export interface DetailsChip {
  readonly label: string;
  readonly spoken: string;
  readonly hint: string;
}

/** The Details chip. A null slug is a new note, which has no ID until it is saved. */
export const detailsChip = (input: {
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
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

/* ---------------------------------------------------------------------------------- move sheet */

export const MOVE_SHEET_TITLE = 'Where should this go?';
export const moveSheetSubtitle = (current: string): string =>
  `In ${current} now. Tap a place to move this there.`;
export const moveBusySubtitle = (place: string): string => `Moving to ${place}…`;

export const MOVE_ROOT_LABEL = 'Areas';
export const MOVE_ROOT_TAG = 'Top level';
export const MOVE_ROOT_HINT = 'Moves this area to the top level';
export const MOVE_ROOT_CURRENT_HINT = 'It is here now. Closes this sheet';
export const MOVE_ROOT_PLACE = 'the top level';

export const MOVE_EYEBROW_HINT = 'Moves this somewhere else';
export const MOVE_CLOSE_WAITING_HINT = 'Available once your server has answered';

export const MOVE_TREE_FAILED =
  'Unable to load areas and projects. Where this is filed has not changed.';
export const MOVE_TREE_NO_MATCH = 'Nothing here matches that. Try a shorter word.';
export const MOVE_TREE_EMPTY = 'No area or project here can hold this.';

export const moveRowCopy = (word: string) => ({
  hint: (title: string) => `Moves this ${word} into ${title}`,
  chosen: (title: string) => `${title} is where this goes`,
});

/* ---------------------------------------------------------------------------------- Unfinished */

/** The four reasons something is listed in Unfinished. A row syncing normally is not listed. */
export type UnfinishedStanding = 'draft' | 'waiting' | 'refused' | 'conflict';

export const UNFINISHED_STATE: Record<UnfinishedStanding, string> = {
  draft: 'Draft',
  waiting: 'Waiting to sync',
  refused: 'Not saved',
  conflict: 'Changed on your server',
};

export const UNFINISHED_OPEN_HINT: Record<UnfinishedStanding, string> = {
  draft: 'Opens the draft to finish and save it',
  waiting: 'Opens it. Raphael keeps trying to send it',
  refused: 'Opens it so you can fix what your server refused',
  conflict: 'Opens it to choose which version stays',
};

export const UNFINISHED_INTRO = 'Writing that hasn’t reached your server yet.';
export const UNFINISHED_EMPTY = 'Nothing unfinished. Everything you wrote made it to your server.';

/** Discard is a shortcut for rows nobody cares about any more; opening a row is how to resolve it. */
export const unfinishedDiscardPrompt = (standing: UnfinishedStanding) =>
  standing === 'conflict'
    ? {
        title: 'Discard your changes?',
        message: 'Your server’s version stays as it is.',
        keepLabel: 'Keep it',
      }
    : {
        title: standing === 'draft' ? 'Discard this draft?' : 'Discard this?',
        message: 'What you wrote will not be saved anywhere.',
        keepLabel: 'Keep it',
      };
