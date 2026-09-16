/**
 * The capture capability's public interface.
 *
 * One thing is published: the owner, and the vocabulary a screen needs to render what it holds. The
 * store, the schema, the SQL, the frozen-request mechanics and the certainty policy are all private,
 * because the whole point of the owner is that exactly one thing decides what is protected, what may
 * be sent and what may be cleared. A consumer that could open the database, write a row, or re-derive
 * a standing from an attempt's fields would be a second authority on the question that decides
 * whether someone's writing is duplicated or destroyed.
 *
 * That is why the policy functions are absent even though screens plainly care about their answers.
 * `standingFor` answers instead, from the owner, over records it holds — so there is no way to ask
 * the question against a stale projection or a record assembled somewhere else.
 *
 * The owner is not composed here. `createCaptureOwner` takes ports, and Phase 06 is what binds them
 * to Expo SQLite, `@raphael/client` and the app's caches, mounts one instance for the process, closes
 * it on teardown, and adds the storage gate. That composition lives inside this capability and
 * reaches `store.ts` and `schema.ts` directly; nothing outside it can. Until then this is tested code
 * with no production wiring, which is the phase's declared debt.
 */

export { VoiceCaptureSheet } from './components/VoiceCaptureSheet';
export { CaptureBar } from './components/CaptureBar';
export {
  createCaptureOwner,
  type ActionOutcome,
  type AttachmentToken,
  type CaptureOwner,
  type CapturePorts,
  type CaptureSession,
  type CaptureState,
  type DraftOutcome,
  type DraftProtection,
  type FlushResult,
  type NotSavedReason,
  type SaveOutcome,
  type SnapshotResult,
  type StoreProblem,
} from './owner.ts';
/** Why capture cannot work right now, in bounded vocabulary the surface writes its own words from. */
export type { StoreFailure } from './store.ts';
/** What `standingFor` answers with. The rules that produce it stay inside. */
export type { BlockedReason, Standing, UnsendableCause } from './policy.ts';
/** Reading an attempt's submitted content back for recovery. Never rewrites the stored bytes. */
export { recoverNoteInput, type RecoveredNote } from './freeze.ts';
export type {
  AcknowledgedNote,
  AttemptOutcome,
  Destination,
  DraftProblem,
  NoteAttemptRecord,
  NoteDraftRecord,
  UnusableDraft,
} from './types.ts';
