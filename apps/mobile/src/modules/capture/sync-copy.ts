/**
 * What the composer, the editor and Unfinished say under the online-only model: one local `unsent`
 * row per piece of writing the server does not have yet.
 *
 * Accepted in phase 01 of the online-only plan and not yet wired: phase 03 replaces `copy.ts`,
 * `composer.ts` and `edit-composer.ts` with these when it builds the `unsent` runner.
 */

export interface StatusLine {
  readonly text: string;
  readonly tone: 'quiet' | 'alert';
}

/** Where a new note stands. Only a refusal is said in the error colour: nothing else is wrong. */
export type CreateStanding =
  | { readonly kind: 'draft'; readonly placed: boolean; readonly written: boolean }
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
      if (!standing.placed) return { text: 'Draft · choose where it goes to save', tone: 'quiet' };
      if (!standing.written) {
        return { text: 'Draft · add a title or some writing to save', tone: 'quiet' };
      }
      return { text: 'Draft · on this phone', tone: 'quiet' };
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
