/**
 * The capture capability's public interface.
 *
 * What it publishes is the *composition* - the screens, the gate, the cards and the hooks a host
 * needs to put them somewhere - plus the owner for the tests that drive it. What it does not publish
 * is the store, the schema, the SQL, the frozen-request mechanics or the certainty policy, because
 * the whole point of the owner is that exactly one thing decides what is protected, what may be sent
 * and what may be cleared. A consumer that could open the database, write a row, or re-derive a
 * standing from an attempt's fields would be a second authority on the question that decides whether
 * someone's writing is duplicated or destroyed.
 *
 * That is why `standingFor` is reached only through the owner, and why recovery draws from
 * `useUnfinishedNotes` - and Home reads through `useUnfinishedTally` - rather than reading `drafts`
 * and `attempts`: the projection is derived in one place, from the owner's own answers, so no screen
 * can disagree with another about what a record means.
 *
 * Capture is also the only capability that opens a local operational database through
 * `infrastructure/sqlite`, and `tests/architecture.test.mjs` holds that line.
 */

export { VoiceCaptureSheet } from './components/VoiceCaptureSheet';
// The pair itself is private: what a host mounts is the dock, which owns the one rule that matters -
// a draft exists before a composer opens over it - so no screen can wire New note a second way.
export { CaptureDock, type CaptureDockProps } from './components/CaptureDock';
export { CaptureScreen, type CaptureScreenProps } from './components/CaptureScreen';
/** The editor over an existing entity. One screen for notes and containers alike. */
export { EditScreen, type EditScreenProps } from './components/EditScreen';
export { RecoveryScreen } from './components/RecoveryScreen';
export { StorageGate } from './components/StorageGate';
// Temporary: archive mock for story #8. Delete with `components/archive-mock` and `app/mock-archive.tsx`.
export { ArchiveMock } from './components/archive-mock/ArchiveMock';

/** The app-lifetime composition. Opened once, above the connection gate. */
export { useCaptureLifetime, useCaptureSession } from './client/owner.ts';
/** The second owner over the same database. Its store, schema and rules stay inside, as the first's do. */
export { useEditLifetime, useEditOwner } from './client/edit-owner.ts';
export { useEditActions, useUnfinishedEdits } from './client/edits.ts';
export { useNewNote, type NewNote } from './client/new-note.ts';
export {
  useSaveNotice,
  useUnfinishedActions,
  useUnfinishedNotes,
  useUnfinishedTally,
  type UnfinishedTally,
} from './client/notes.ts';
export { useDestinationName, type DestinationName } from './client/destinations.ts';

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
/**
 * The edit owner's vocabulary, and nothing that decides anything.
 *
 * `edit-policy.ts`, `edit-composer.ts` and the store stay private for the reason the creation side's
 * do: a consumer that could re-derive a standing would be a second authority on whether someone's
 * writing is on their server.
 */
export {
  createEditOwner,
  type EditLocation,
  type EditOpenOutcome,
  type EditOwner,
  type EditPorts,
  type EditState,
  type LeaveOutcome,
} from './edit-owner.ts';
export type { EditStanding } from './edit-policy.ts';
export type { EditContent, EditProblem, EditRefusal, EntityEditRecord } from './edit-types.ts';
export type { UnfinishedEdit } from './edit-unfinished.ts';
/** Reading an attempt's submitted content back for recovery. Never rewrites the stored bytes. */
export { recoverNoteInput, type RecoveredNote } from './freeze.ts';
/** What Home and recovery draw. Derived from the owner's answers, never re-derived from rows. */
export type {
  SaveReceipt,
  UnfinishedAction,
  UnfinishedNote,
  UnfinishedStatus,
  WithdrawnReason,
} from './unfinished.ts';
export type {
  AcknowledgedNote,
  AttemptOutcome,
  Destination,
  DraftProblem,
  NoteAttemptRecord,
  NoteDraftRecord,
  UnusableDraft,
} from './types.ts';
