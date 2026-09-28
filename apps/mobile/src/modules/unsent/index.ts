/**
 * Writing the server does not have yet: one local table, one runner that sends it.
 *
 * It depends only on infrastructure, `@raphael/*` and the connection's session and reachability.
 * `capture` and `collections` build their screens on it, never the reverse. It is the only capability
 * that opens a SQLite database.
 */

export {
  discardAllUnsent,
  discardUnsent,
  keepMine,
  leaveDraft,
  resumeUnsent,
  retryNow,
  saveDraft,
  startDraft,
  startUnsent,
  useNodeUnsent,
  useUnfinished,
  useUnsentCount,
  useUnsentRow,
  useUnsentStatus,
  writeDraft,
  writeEdit,
  type CreatePatch,
  type NewItem,
  type SaveResult,
} from './client/unsent';
export { announce, useNotice, type Notice } from './state/notice.ts';
export {
  createProblem,
  parentIdOf,
  titleFor,
  type CreateProblem,
  type Destination,
  type UnsentRow,
  type UnsentStatus,
} from './row.ts';
export type { Synced } from './runner.ts';
export type { SyncOutcome } from './transition.ts';
