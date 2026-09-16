/**
 * What capture says about a note that is not finished.
 *
 * One file, because the same situation is described on a Home card, on a recovery card and at the
 * top of the composer, and three separately-written sentences about "we do not know whether this
 * saved" is how a product ends up telling someone two different things about one note.
 *
 * The rule every sentence here obeys: **a refusal of the latest request is never reported as
 * "nothing was created"** unless nothing was ever uncertain. A first dispatch can commit and lose
 * its answer, and a replay under the same key can then take a perfectly valid refusal - that refusal
 * is about the replay, and the creation remains genuinely unresolved.
 */

import type { DraftProblem } from './types.ts';
import type { UnfinishedStatus, WithdrawnReason } from './unfinished.ts';

/** The line above the title on a card. Status where a saved note carries its location. */
export const EYEBROW: Record<UnfinishedStatus, string> = {
  unresolved: 'Save not confirmed',
  unresolved_withdrawn: 'Save not confirmed',
  unrecorded_success: 'Created · not recorded here',
  refused: 'Not saved',
  draft: 'Draft · on this phone',
  remainder: 'On your server · newer writing here',
  inconsistent: 'Save not confirmed',
  unusable: 'Kept · cannot be opened here',
};

/** Whether the eyebrow is said in the error colour. Drafts and remainders are not problems. */
export const isAlarming = (status: UnfinishedStatus): boolean =>
  status !== 'draft' && status !== 'remainder' && status !== 'unusable';

const WITHDRAWN: Record<WithdrawnReason, string> = {
  window_ended:
    'It is too late to send exactly the same request again, so look in the destination before creating it again.',
  clock_anomaly:
    'The clock changed, so Raphael cannot establish whether the same request can still be sent. Look in the destination before creating it again.',
  conflict:
    'Your server refused the last try as a conflict, so sending it again cannot help. Look in the destination before creating it again.',
  unusable_payload:
    'This request was saved by a different version of Raphael and cannot be sent again. What you wrote is kept on this phone.',
};

/**
 * The one sentence a card says under its title.
 *
 * `withdrawn` only ever refines an unresolved save: it says why the same request can no longer be
 * sent, never that the note does not exist.
 */
export const sentenceFor = (
  status: UnfinishedStatus,
  withdrawn: WithdrawnReason | null,
  problem?: DraftProblem | undefined,
): string => {
  switch (status) {
    case 'unresolved':
      return 'Raphael sent this and never heard back, so it cannot tell whether your server created it.';
    case 'unresolved_withdrawn':
      return `Raphael sent this and never heard back. ${withdrawn === null ? '' : WITHDRAWN[withdrawn]}`.trim();
    case 'unrecorded_success':
      return 'Your server created this. Raphael could not write that down on this phone, so it is being kept in memory until it can.';
    case 'refused':
      return 'Your server refused this and created nothing. What you wrote is kept here.';
    case 'draft':
      return 'Written on this phone and not sent yet.';
    case 'remainder':
      return 'This note is on your server. What you wrote afterwards is kept here and is not on it.';
    case 'inconsistent':
      return 'Raphael’s record of this note contradicts itself, so it will not guess. Nothing has been removed.';
    case 'unusable':
      return UNUSABLE_SENTENCE[problem ?? 'unreadable_row'];
  }
};

/**
 * Why a retained note cannot be opened here.
 *
 * Three different facts, and none of them is "it is gone". Each says what was kept and what would
 * make it readable, because the one thing this app must never do with a row it cannot understand is
 * rewrite it or quietly drop it.
 */
const UNUSABLE_SENTENCE: Record<DraftProblem, string> = {
  unsupported_content_schema:
    'This note was written by a different version of Raphael, and this one cannot open it. It is kept exactly as it is; a newer version will be able to read it.',
  unusable_body:
    'This note’s body is not something this version of Raphael can open. It is kept exactly as it is rather than changed or removed.',
  unreadable_row:
    'Raphael could not read this note’s record on this phone. It is kept exactly as it is rather than changed or removed.',
};

/** Discarding is three different acts, and the confirmation has to say which one it is. */
export const discardPromptFor = (status: UnfinishedStatus) => {
  switch (status) {
    case 'unresolved':
    case 'unresolved_withdrawn':
    case 'inconsistent':
      return {
        title: 'Discard this note?',
        message:
          'What you wrote is removed from this phone. Raphael keeps its record of the save it could not confirm, because discarding writing cannot undo a creation your server may already have made.',
        keepLabel: 'Keep it',
      };
    case 'unrecorded_success':
    case 'remainder':
      return {
        title: 'Discard what is kept here?',
        message:
          'The note on your server is not touched. Only the writing kept on this phone is removed.',
        keepLabel: 'Keep it',
      };
    case 'draft':
    case 'refused':
    case 'unusable':
      return {
        title: 'Discard this note?',
        message: 'What you wrote will not be saved anywhere.',
        keepLabel: 'Keep it',
      };
  }
};

/** A draft nobody has titled is not a draft with a bad title. */
export const displayTitle = (title: string): string =>
  title.trim() === '' ? 'Untitled note' : title;

export const RETIRED_HEADING = 'From another server';

/**
 * For rows whose own record could not be read well enough to say where they came from.
 *
 * Its own heading rather than a bucket in the previous one, because "from another server" is a
 * claim, and the whole reason these rows are here is that the claim cannot be made.
 */
export const UNKNOWN_HEADING = 'Server not readable';

export const UNKNOWN_SENTENCE =
  'Raphael could not read which server these belong to. They are kept exactly as they are.';

export const RETIRED_SENTENCE =
  'This belongs to a server this phone is no longer connected to. Raphael will never send it or bind it to the current one; copy the writing into a new note here, or discard it.';

export const COPY_NOTICE =
  'Copied into a new note on this server. Choose where it goes before saving it.';

/** The success snackbar, which never claims the save happened a moment ago. */
export const savedIn = (destination: string | null): string =>
  destination === null ? 'Saved on your server.' : `Saved in ${destination}.`;
