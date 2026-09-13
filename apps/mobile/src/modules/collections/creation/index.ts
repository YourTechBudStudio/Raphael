/**
 * Container creation, and the record of every attempt at one.
 *
 * Private to `modules/collections`. The rest of the app reaches creation through the collections
 * interface, and the architecture test holds that line - not because the boundary is delicate, but
 * because this is the code that decides whether an unfinished creation is resent, and a second
 * caller of it would be a second dispatcher.
 */

export { AttemptCard, type AttemptActions, type AttemptCardProps } from './AttemptCard.tsx';
export { NewContainerSheet, type NewContainerSheetProps } from './NewContainerSheet.tsx';
export { PendingAttempts, type PendingAttemptsProps } from './PendingAttempts.tsx';
export { PendingSummary, type PendingSummaryProps } from './PendingSummary.tsx';
export {
  byAttemptAge,
  correctionAllowed,
  createdBy,
  logicalStateOf,
  viewOf,
  type AttemptView,
} from './derive.ts';
export {
  emptyDraft,
  INCOMPLETE_RECOVERY_NOTICE,
  recoveredDraft,
  SEPARATE_CREATION_NOTICE,
  type Draft,
} from './draft.ts';
export { recoverInput, type RecoveredInput } from './freeze.ts';
export { RETRY_WINDOW_MS } from './eligibility.ts';
export { ATTEMPTS_DATABASE, CREATION_MIGRATIONS } from './schema.ts';
export { openAttemptStore, type AttemptStore, type OpenOutcome } from './store.ts';
export { createCreationOwner, type CreationPorts, type CreationSession } from './owner.ts';
export type { AttemptRecord, AttemptState, ContainerTarget, LogicalState } from './types.ts';
