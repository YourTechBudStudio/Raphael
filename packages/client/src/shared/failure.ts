import type { ApiErrorDetails } from '@raphael/contracts';

/**
 * What can go wrong with a request, as one flat shape.
 *
 * `http` is any answer on a status the operation does not succeed with; `code` is present when the
 * body was a Raphael error envelope, and `message` is then the server's own sentence. `bad_response`
 * is an answer this client cannot read as Raphael's, including a server speaking an incompatible
 * protocol (`code: 'incompatible_protocol'`).
 *
 * `effect` and `delivery` together say what a caller may conclude about the server's state. A read
 * changes nothing whatever happened. A write that was `not_sent` changed nothing; one that was
 * `answered` with a refusal changed nothing; one whose delivery is `unknown` may have been applied,
 * and must be checked before it is sent again.
 */
export interface ClientFailure {
  readonly kind: 'network' | 'timeout' | 'cancelled' | 'invalid_request' | 'http' | 'bad_response';
  /** Whether the operation that failed changes stored state. */
  readonly effect: OperationEffect;
  readonly delivery: FailureDelivery;
  readonly status?: number;
  readonly code?: string;
  /** Safe to show. Never contains a credential or a response body. */
  readonly message: string;
  /** The server's structured facts about an `http` failure, when its envelope carried any. */
  readonly details?: ApiErrorDetails;
}

/** A capability declares this for each operation; the transport cannot tell from the route. */
export type OperationEffect = 'read' | 'write';

/**
 * How far a failed request got.
 *
 * - `not_sent`: the request provably never reached the server: refused locally, cancelled before it
 *   left, or a connection that could not be opened.
 * - `answered`: the server answered, with a status this client did not accept.
 * - `unknown`: the request may have reached the server and no definite answer came back - a timeout,
 *   a connection lost mid-exchange, a cancellation after sending. Anything this client cannot place
 *   is `unknown`, because claiming "not sent" for a write that landed is the error that duplicates it.
 */
export type FailureDelivery = 'not_sent' | 'answered' | 'unknown';

export type ClientResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ClientFailure };

export const succeed = <A>(value: A): ClientResult<A> => ({ ok: true, value });
export const fail = <A>(failure: ClientFailure): ClientResult<A> => ({ ok: false, failure });

/**
 * Worth sending again unchanged: the server was unreachable, slow, or had a problem of its own.
 *
 * This is the mobile retry queue's rule, and it relies on reconciliation (ADR 0002): a repeated
 * create meets its own first attempt as a slug conflict, and a repeated update meets it as a revision
 * conflict. A caller that cannot reconcile a write whose outcome is unknown must not read this as "the
 * write did not happen"; `delivery` is what says that.
 */
export const retryable = (failure: Pick<ClientFailure, 'kind' | 'status'>): boolean =>
  failure.kind === 'network' ||
  failure.kind === 'timeout' ||
  (failure.kind === 'http' && (failure.status ?? 0) >= 500);
