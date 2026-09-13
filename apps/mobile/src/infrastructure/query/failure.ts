/**
 * Carrying a `ClientResult` failure through React Query without losing what it said.
 *
 * The shared client answers with `{ ok: false, failure }` rather than throwing, because a failure
 * there is a value with structure: which condition broke, and what that means for an entity the
 * request may have created. React Query decides success and failure by whether the query function
 * throws. Returning the result object unchanged would therefore cache `{ ok: false }` as
 * successful data, and every screen would have to remember to unwrap it before believing it.
 *
 * So the adapter is one-way and total: a failure becomes a thrown `ClientFailureError` carrying
 * the original value, and a success becomes the value itself. Nothing else in the app inspects
 * `result.ok`.
 */

import type { ClientFailure, ClientResult } from '@raphael/client';

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

/**
 * Whether trying the same request again could plausibly answer differently.
 *
 * The default in a query library is to retry everything a fixed number of times, which is wrong in
 * both directions here. A refused key is not going to be accepted on the third attempt, and
 * hammering it turns one rejection into a burst against a server that already said no; a protocol
 * mismatch and a malformed request are settled facts about the two programs. What is worth
 * retrying is the genuinely transient: the exchange that failed opaquely, and the wait that ran
 * out. A cancelled request is never retried, because someone or something asked for it to stop.
 */
export const isRetryableFailure = (failure: ClientFailure): boolean => {
  switch (failure.kind) {
    case 'transport':
    case 'timeout':
      return true;
    case 'api_error':
      // 5xx is the server having a bad moment; 4xx is the server having an opinion.
      return failure.status >= 500;
    case 'invalid_request':
    case 'cancelled':
    case 'unsupported_fetch':
    case 'invalid_response':
      return false;
  }
};

/** How many times a retryable failure is tried again before the query gives up and says so. */
export const MAX_RETRIES = 2;

export const shouldRetry = (attempt: number, error: unknown): boolean => {
  const failure = asClientFailure(error);

  // Anything that is not a client failure came from our own code, and repeating it will not fix it.
  if (failure === null) return false;

  return attempt < MAX_RETRIES && isRetryableFailure(failure);
};

/**
 * A failure that says the connection itself is the problem, rather than this one request.
 *
 * `unauthorized` is deliberately narrow. A bare 401 from a proxy sitting in front of the server is
 * not Raphael refusing a key - it is something else entirely refusing to pass the request on - and
 * the client reports that as an unreadable response rather than as an API error. Only a
 * well-formed Raphael error envelope reaches `api_error`, so only that is taken as the server
 * having considered this key and declined it.
 */
export type ConnectionRejection = 'unauthorized' | 'incompatible_protocol';

export const connectionRejectionOf = (failure: ClientFailure): ConnectionRejection | null => {
  if (failure.kind === 'api_error' && (failure.status === 401 || failure.status === 403)) {
    return 'unauthorized';
  }

  if (failure.kind === 'invalid_response' && failure.reason === 'incompatible_protocol') {
    return 'incompatible_protocol';
  }

  return null;
};

/**
 * Whether the server said, definitely, that there is no such container.
 *
 * A deleted area and an area that could not be read look identical to a screen that only knows the
 * request failed, and they need opposite answers: one is "this is gone", the other is "try again".
 * Offering a retry button for something that no longer exists loops someone through a failure that
 * will never resolve, and saying "not here" about a timeout is a claim about their data made from a
 * network error.
 *
 * Narrow on purpose. Only a well-formed Raphael error envelope reaches `api_error`, so a 404 page
 * from a proxy in front of the server is read as an unintelligible answer and is not taken as the
 * server having looked and found nothing.
 */
export const isNotFound = (failure: ClientFailure): boolean =>
  failure.kind === 'api_error' && failure.status === 404;
