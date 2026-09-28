/**
 * Carrying a `ClientResult` failure through React Query without losing what it said.
 *
 * The shared client answers with `{ ok: false, failure }` rather than throwing. React Query decides
 * success by whether the query function throws, so a failure becomes a thrown `ClientFailureError`
 * carrying the original value, and a success becomes the value itself.
 */

import { retryable, type ClientFailure, type ClientResult } from '@raphael/client';

export class ClientFailureError extends Error {
  readonly failure: ClientFailure;

  constructor(failure: ClientFailure) {
    super(failure.message);
    this.name = 'ClientFailureError';
    this.failure = failure;
  }
}

/** The value, or a throw that keeps the failure intact. */
export const unwrap = <A>(result: ClientResult<A>): A => {
  if (!result.ok) throw new ClientFailureError(result.failure);

  return result.value;
};

export const asClientFailure = (error: unknown): ClientFailure | null =>
  error instanceof ClientFailureError ? error.failure : null;

/** How many times a retryable failure is tried again before the query gives up and says so. */
export const MAX_RETRIES = 2;

/** Only the client's own `retryable` failures are repeated; anything else is an answer or our bug. */
export const shouldRetry = (failureCount: number, error: unknown): boolean => {
  const failure = asClientFailure(error);

  return failure !== null && failureCount < MAX_RETRIES && retryable(failure);
};

/**
 * A failure that says the connection itself is the problem, rather than this one request.
 *
 * Only a Raphael error envelope (one with a `code`) counts: a bare 401 from a proxy in front of the
 * server is not Raphael refusing the key.
 */
export type ConnectionRejection = 'unauthorized' | 'incompatible_protocol';

export const connectionRejectionOf = (failure: ClientFailure): ConnectionRejection | null => {
  if (failure.kind === 'http' && failure.code !== undefined) {
    if (failure.status === 401 || failure.status === 403) return 'unauthorized';
  }

  if (failure.kind === 'bad_response' && failure.code === 'incompatible_protocol') {
    return 'incompatible_protocol';
  }

  return null;
};

/** The server looked and found nothing. A proxy's 404 page carries no code and does not count. */
export const isNotFound = (failure: ClientFailure): boolean =>
  failure.kind === 'http' && failure.status === 404 && failure.code !== undefined;
