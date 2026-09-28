/**
 * What can go wrong with a request, as one flat shape.
 *
 * `http` is any answer on a status the operation does not succeed with; `code` is present when the
 * body was a Raphael error envelope, and `message` is then the server's own sentence. `bad_response`
 * is an answer this client cannot read as Raphael's, including a server speaking an incompatible
 * protocol (`code: 'incompatible_protocol'`).
 */
export interface ClientFailure {
  readonly kind: 'network' | 'timeout' | 'cancelled' | 'invalid_request' | 'http' | 'bad_response';
  readonly status?: number;
  readonly code?: string;
  /** Safe to show. Never contains a credential or a response body. */
  readonly message: string;
}

export type ClientResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ClientFailure };

export const succeed = <A>(value: A): ClientResult<A> => ({ ok: true, value });
export const fail = <A>(failure: ClientFailure): ClientResult<A> => ({ ok: false, failure });

/** Worth sending again unchanged: the server was unreachable, slow, or had a problem of its own. */
export const retryable = (failure: ClientFailure): boolean =>
  failure.kind === 'network' ||
  failure.kind === 'timeout' ||
  (failure.kind === 'http' && (failure.status ?? 0) >= 500);
