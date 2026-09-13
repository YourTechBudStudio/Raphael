/**
 * The unsent form, and the words used about an attempt once it has left.
 *
 * What remains of the reviewed phase 07 reducer. It used to own the attempt - the key, when that key
 * was spent, whether a request was in flight - and it does not any more, because those are facts
 * about a request that may have reached a server and they have to survive the process. They live in
 * the durable record now, and the rules about them live in the owner.
 *
 * What genuinely belonged here is still here: an unsent draft is local, disposable, and nobody
 * else's business, and the sentences said about an attempt are a presentation decision made once
 * rather than on each screen that shows one.
 */

import { WINDOW_ENDED_MESSAGE, CLOCK_ANOMALY_MESSAGE } from './eligibility.ts';
import type { RecoveredInput } from './freeze.ts';
import type { AttemptRecord } from './types.ts';

export interface Draft {
  readonly title: string;
  /** Markdown source, as written. Never trimmed: whitespace someone typed is theirs. */
  readonly body: string;
  /** Why the last save did not happen. */
  readonly problem: string | null;
  /** Something true that is not a problem, such as arriving here from an abandoned attempt. */
  readonly notice: string | null;
}

export type DraftField = 'title' | 'body';

export type DraftEvent =
  | { readonly type: 'edit'; readonly field: DraftField; readonly value: string }
  | { readonly type: 'problem'; readonly message: string }
  | { readonly type: 'notice'; readonly message: string };

export const emptyDraft = (): Draft => ({ title: '', body: '', problem: null, notice: null });

/**
 * A draft carrying input recovered from an earlier attempt, with the reason it is here.
 *
 * The body comes from the frozen request, not from nowhere. An earlier version of this hard-coded
 * an empty one, which for a definite refusal was silent data loss: correcting the title replaces the
 * old record atomically, so the only stored copy of what the person had written went with it.
 */
export const recoveredDraft = (input: RecoveredInput, notice: string | null): Draft => ({
  title: input.title,
  body: input.body,
  problem: null,
  notice,
});

export const INCOMPLETE_RECOVERY_NOTICE =
  'This attempt was saved by a different version of Raphael. Raphael has recovered what it could read; check it before saving.';

export const reduceDraft = (draft: Draft, event: DraftEvent): Draft => {
  switch (event.type) {
    case 'edit':
      // Typing is the answer to a problem, so the problem goes. The notice stays: it explains how
      // this draft came to exist, which is still true however much is typed into it.
      return { ...draft, [event.field]: event.value, problem: null };
    case 'problem':
      return { ...draft, problem: event.message };
    case 'notice':
      return { ...draft, notice: event.message };
  }
};

/** Whether closing would throw away writing. The title is trimmed; the body is not. */
export const hasContent = (draft: Draft): boolean => draft.title.trim() !== '' || draft.body !== '';

export const SEPARATE_CREATION_NOTICE =
  'The earlier creation may exist. This starts a separate creation and keeps the earlier record for review.';

/**
 * What is said over a locked title while the outcome is unknown.
 *
 * "Raphael can't tell" rather than "it failed", because the request left and no answer came back is
 * precisely not a failure - it is the absence of one.
 */
export const describeUnresolved = (title: string): string =>
  `Raphael can't tell whether ${title} was created. The request left, and no answer came back.`;

/** What is said once the window has closed. It never claims the server has forgotten the attempt. */
export const describeUnsendable = (record: AttemptRecord): string =>
  record.clockAnomaly ? CLOCK_ANOMALY_MESSAGE : WINDOW_ENDED_MESSAGE;

/**
 * What is said about a slug collision.
 *
 * Deliberately not "the earlier one worked". A conflict proves that something occupies that address
 * now, and another client, another attempt, or another title deriving the same slug would all
 * produce it. Telling someone their creation succeeded on that evidence is a guess about their data.
 */
export const COLLISION_MESSAGE =
  'Something already uses that address. It may be the earlier creation; inspect it before creating another.';

/** The warning before a local record is thrown away while its outcome is unknown. */
/** Discarding something known to have created nothing. There is no ambiguity to warn about. */
export const DISCARD_REFUSED_PROMPT = {
  title: 'Discard this record?',
  message:
    'The server refused this, so nothing was created. What you wrote will be removed from this phone.',
  keepLabel: 'Keep it',
} as const;

export const DISCARD_UNRESOLVED_PROMPT = {
  title: 'Discard this record?',
  message:
    'This removes Raphael’s record of the attempt on this phone. It cannot undo a creation the server may already have made.',
  keepLabel: 'Keep it',
} as const;
