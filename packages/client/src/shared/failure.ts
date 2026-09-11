/**
 * What can go wrong, and what it means for work the server may have done.
 *
 * Two questions get asked of every failure and they have different answers, so they are two fields.
 *
 * `kind` says what happened to the *request*: it never left, it was refused, the answer was
 * unintelligible, the wait was abandoned. `mutationOutcome` says what happened to the *entity* the
 * request was trying to create. Collapsing them into one enum is how a client ends up telling someone
 * a creation definitely failed because the socket reset, which is exactly the claim it cannot make.
 *
 * The conservative direction is deliberate and costs real usability. A server that is not running
 * produces the same opaque `TypeError` from `fetch` as a connection reset halfway through a commit.
 * Node's undici exposes `error.cause.code` and would let us say "nothing was sent" for the first case,
 * but React Native's fetch does not, so the same failure would classify differently on two clients
 * built from one transport. A platform-conditional certainty claim is the shape of bug this whole
 * design exists to avoid, so every post-dispatch transport failure is `unknown` - and `raphael create`
 * against a stopped server will over-cautiously tell someone their request might have landed.
 */

import type { ClassifiedApiError, RecoveryDetails } from '@raphael/contracts';

/**
 * What happened to the entity a mutating request was trying to create.
 *
 * These statements are about **this attempt only**. A rejected retry says nothing about whether an
 * earlier attempt with the same idempotency key created something, and neither does a definite
 * rejection here.
 */
export type MutationOutcome =
  /** The request never reached the network: local validation failed, or the caller cancelled first. */
  | 'not_dispatched'
  /** The server answered, intelligibly and consistently, that it refused. Nothing was created. */
  | 'rejected'
  /** It may or may not have been created. Nothing here establishes which. */
  | 'unknown'
  /** The operation does not mutate, so the question does not arise. */
  | 'not_applicable';

export type FailureKind =
  /** The request did not satisfy its own contract and was never sent. */
  | 'invalid_request'
  /** The bounded timeout elapsed. */
  | 'timeout'
  /** The caller's signal aborted the request. */
  | 'cancelled'
  /** The request was handed to fetch and the exchange failed opaquely. */
  | 'transport'
  /** Something answered, but not something this client can read as a Raphael response. */
  | 'invalid_response'
  /** A well-formed Raphael error envelope. */
  | 'api_error'
  /** The injected fetch implementation cannot do what this transport requires. */
  | 'unsupported_fetch';

/** Why a response could not be read as a Raphael answer. */
export type InvalidResponseReason =
  /** A 3xx. Refused before the body is touched, because following it would disclose the credential. */
  | 'redirect_refused'
  /** A status the operation's contract does not define, such as 204 or 304. */
  | 'unexpected_status'
  /** The response carried no body where an envelope was required. */
  | 'empty_response'
  /** The body exceeded the client's ceiling. */
  | 'response_too_large'
  /** The body was not valid UTF-8. */
  | 'invalid_utf8'
  /** The body was not JSON. */
  | 'malformed_json'
  /** Valid JSON that did not match the operation's response contract. */
  | 'invalid_payload'
  /** An error envelope whose code and status contradict each other. */
  | 'inconsistent_error'
  /** An error status carrying something that is not an error envelope. */
  | 'unrecognized_error'
  /** A readable answer from a server speaking a protocol version this client does not understand. */
  | 'incompatible_protocol';

interface FailureBase {
  readonly mutationOutcome: MutationOutcome;
  /** Safe to show. Never contains a credential, a response body, or a decoder message. */
  readonly message: string;
}

export interface InvalidRequestFailure extends FailureBase {
  readonly kind: 'invalid_request';
  readonly mutationOutcome: 'not_dispatched';
  /** Where in the request the problem is, by property path. */
  readonly path: readonly (string | number)[];
}

export interface TimeoutFailure extends FailureBase {
  readonly kind: 'timeout';
  readonly timeoutMs: number;
}

export interface CancelledFailure extends FailureBase {
  readonly kind: 'cancelled';
}

export interface TransportFailure extends FailureBase {
  readonly kind: 'transport';
}

export interface InvalidResponseFailure extends FailureBase {
  readonly kind: 'invalid_response';
  readonly reason: InvalidResponseReason;
  /** The status actually observed, when there was one. Kept as a fact, never used to infer a code. */
  readonly status?: number;
}

export interface ApiErrorFailure extends FailureBase {
  readonly kind: 'api_error';
  readonly status: number;
  readonly error: ClassifiedApiError;
  /** The validated subset of `error.details` that is safe to show. */
  readonly details: RecoveryDetails;
}

export interface UnsupportedFetchFailure extends FailureBase {
  readonly kind: 'unsupported_fetch';
}

export type ClientFailure =
  | InvalidRequestFailure
  | TimeoutFailure
  | CancelledFailure
  | TransportFailure
  | InvalidResponseFailure
  | ApiErrorFailure
  | UnsupportedFetchFailure;

export type ClientResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly failure: ClientFailure;
    };

export const succeed = <A>(value: A): ClientResult<A> => ({ ok: true, value });
export const fail = <A>(failure: ClientFailure): ClientResult<A> => ({ ok: false, failure });

/**
 * Whether a failure leaves a mutation genuinely unresolved.
 *
 * Exported because it is the question a caller actually has, and computing it from `mutationOutcome`
 * at every call site is how one of them eventually gets it backwards.
 */
export const isUnresolved = (failure: ClientFailure): boolean =>
  failure.mutationOutcome === 'unknown';
