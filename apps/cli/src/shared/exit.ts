/**
 * What an exit code means here, defined once.
 *
 * A code says what the caller should do next, not where the problem was noticed: the same mistake
 * exits the same way whether this CLI caught it or the server did. The table below is the contract;
 * help renders it and the failure renderer is the only thing that chooses a code.
 *
 * The exit code reflects the operation, not whether its output could be delivered. A write that
 * succeeded exits 0 even when the reader of its confirmation went away before it was printed.
 *
 * Signals get their conventional codes so a shell reports what actually happened.
 */

import type { ApiErrorCode } from '@raphael/contracts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_CONFLICT = 4;
export const EXIT_NOT_CONFIGURED = 5;
export const EXIT_RETRYABLE = 6;
export const EXIT_UNKNOWN = 7;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130 | 143;

/** One word per exit code, carried as `category` in the JSON error document. */
export type FailureCategory =
  | 'failed'
  | 'usage'
  | 'not_found'
  | 'conflict'
  | 'not_configured'
  | 'retryable'
  | 'outcome_unknown'
  | 'interrupted';

export interface ExitCodeEntry {
  readonly code: ExitCode;
  readonly category: FailureCategory | 'ok';
  readonly meaning: string;
}

/** The table, in order. Help renders its exit-code summary from it. */
export const EXIT_CODES: readonly ExitCodeEntry[] = [
  {
    code: EXIT_OK,
    category: 'ok',
    meaning: 'Done. This includes no-ops and success with warnings.',
  },
  {
    code: EXIT_FAILURE,
    category: 'failed',
    meaning: 'Failed for another reason, with nothing left uncertain.',
  },
  {
    code: EXIT_USAGE,
    category: 'usage',
    meaning: 'The command as typed can never succeed; nothing was applied.',
  },
  { code: EXIT_NOT_FOUND, category: 'not_found', meaning: 'Not found.' },
  {
    code: EXIT_CONFLICT,
    category: 'conflict',
    meaning: 'Conflicts with stored state; nothing was applied.',
  },
  {
    code: EXIT_NOT_CONFIGURED,
    category: 'not_configured',
    meaning: 'Not configured, or not authorized.',
  },
  { code: EXIT_RETRYABLE, category: 'retryable', meaning: 'Not applied, and retrying may work.' },
  {
    code: EXIT_UNKNOWN,
    category: 'outcome_unknown',
    meaning: 'Outcome unknown: a write was sent and no definite answer came back.',
  },
  { code: EXIT_SIGINT, category: 'interrupted', meaning: 'Interrupted by SIGINT.' },
  { code: EXIT_SIGTERM, category: 'interrupted', meaning: 'Interrupted by SIGTERM.' },
];

export const categoryOf = (code: Exclude<ExitCode, 0>): FailureCategory => {
  const entry = EXIT_CODES.find((candidate) => candidate.code === code);
  // Every non-zero code has a failure category in the table above.
  return (entry?.category ?? 'failed') as FailureCategory;
};

/**
 * How each server code exits. Keyed by the contract's own catalog, so a new code without a mapping
 * fails the typecheck.
 *
 * `internal_error` is the one code whose meaning depends on the request: a read that failed changed
 * nothing, but a write the server could not complete may or may not have been applied, because
 * nothing guarantees it was rolled back.
 */
export const SERVER_CODE_EXIT: Readonly<Record<ApiErrorCode, ExitCode | 'server_fault'>> = {
  invalid_input: EXIT_USAGE,
  payload_too_large: EXIT_USAGE,
  unsupported_media_type: EXIT_USAGE,
  unsupported_content: EXIT_USAGE,
  node_not_found: EXIT_NOT_FOUND,
  slug_conflict: EXIT_CONFLICT,
  revision_conflict: EXIT_CONFLICT,
  node_archived: EXIT_CONFLICT,
  invalid_parent: EXIT_CONFLICT,
  unauthorized: EXIT_NOT_CONFIGURED,
  route_not_found: EXIT_NOT_CONFIGURED,
  method_not_allowed: EXIT_NOT_CONFIGURED,
  storage_busy: EXIT_RETRYABLE,
  internal_error: 'server_fault',
};
