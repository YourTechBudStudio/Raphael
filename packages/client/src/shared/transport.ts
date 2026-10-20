/**
 * The one place a Raphael request is actually sent.
 *
 * The credential is captured in a closure and never travels in a payload, redirects are refused
 * rather than followed, ambient cookies are off, and one timer bounds the whole exchange rather than
 * just the wait for headers. The fetch implementation is injected, so each client states what it uses.
 */

import { decodeApiErrorEnvelope, type Decoder } from '@raphael/contracts';
import {
  AUTHORIZATION_HEADER,
  authorizationHeaderValue,
  hasApiKey,
} from '@raphael/contracts/connection';
import { Either } from 'effect';

import {
  isEndpointRejection,
  parseEndpoint,
  routeUrl,
  type Endpoint,
  type EndpointRejection,
} from './endpoint.ts';
import {
  fail,
  succeed,
  type ClientFailure,
  type ClientResult,
  type OperationEffect,
} from './failure.ts';

/** The whole exchange, not just the wait for headers. */
export const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  /** Absolute URL of the server, optionally carrying a base path. */
  readonly endpoint: string;
  /** The full-access API key. Captured in a closure and never exposed again. */
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

export type TransportRejection =
  | EndpointRejection
  | { readonly reason: 'api_key_missing'; readonly message: string }
  | { readonly reason: 'timeout_out_of_range'; readonly message: string };

export interface Transport {
  readonly endpoint: Endpoint;
  readonly timeoutMs: number;
  /** Internal: capabilities call `invoke`, callers never do. */
  readonly invoke: <A>(call: OperationCall<A>) => Promise<ClientResult<A>>;
}

export interface OperationCall<A> {
  readonly route: { readonly method: 'POST'; readonly path: string };
  /**
   * Whether the operation changes stored state. Every route is a POST, so only the capability knows;
   * it decides what a failure after sending means for the caller.
   */
  readonly effect: OperationEffect;
  /** Already decoded and detached by the capability. Serialized here, once. */
  readonly body: unknown;
  readonly decode: Decoder<A>;
  /** The status a successful answer must carry. Anything else is not a success. */
  readonly successStatus: number;
  readonly signal?: AbortSignal;
}

/**
 * Build a transport, or explain why the configuration cannot be used.
 *
 * Configuration is validated and snapshotted here rather than read per request, so a caller mutating
 * its options object afterwards cannot change where a credential is sent.
 */
export const createTransport = (options: TransportOptions): Transport | TransportRejection => {
  const endpointInput = options.endpoint;
  const apiKey = options.apiKey;
  const fetchImpl = options.fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const endpoint = parseEndpoint(endpointInput);
  if (isEndpointRejection(endpoint)) return endpoint;

  // A key is whatever the owner configured; the only thing that stops a request here is not having
  // one at all. A key that cannot travel in a header - anything outside Latin-1 - is deliberately
  // not refused here and will surface as a network failure at the first request instead.
  if (!hasApiKey(apiKey)) {
    return { reason: 'api_key_missing', message: 'An API key is required to talk to a server.' };
  }
  if (!Number.isSafeInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    return {
      reason: 'timeout_out_of_range',
      message: `The timeout must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    };
  }

  const authorization = authorizationHeaderValue(apiKey);

  return {
    endpoint,
    timeoutMs: timeout,
    invoke: <A>(call: OperationCall<A>): Promise<ClientResult<A>> =>
      dispatch(fetchImpl, endpoint, authorization, timeout, call),
  };
};

export const isTransportRejection = (
  value: Transport | TransportRejection,
): value is TransportRejection => 'reason' in value;

const badResponse = (effect: OperationEffect, message: string, status: number): ClientFailure => ({
  kind: 'bad_response',
  effect,
  delivery: 'answered',
  message,
  status,
});

/**
 * Failure codes that mean the connection was never established, so not a byte of the request reached
 * the server: the name did not resolve, nothing listened, the network had no route, or the server's
 * certificate was refused before anything was sent over it. Everything else that can fail during an
 * exchange might have happened after the request went out.
 */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Refusals a fetch implementation makes before it connects, recognizable only by their message.
 * `bad port` is the Fetch standard's port blocklist (undici words it exactly so): nothing is opened.
 */
const NOT_CONNECTED_MESSAGES: ReadonlySet<string> = new Set(['bad port']);

const codeOf = (value: unknown): string | undefined => {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Whether a failed `fetch` provably never sent the request.
 *
 * Only a socket error carried as the cause can prove it, and only one of the codes above. A connection
 * attempt to several addresses carries every attempt's error, and was not sent only if none connected.
 * A failure with no cause proves nothing: some runtimes (React Native among them) throw one bare
 * `TypeError` for every network failure, before or after the request left.
 */
const neverSent = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  if (cause === undefined) return false;
  const code = codeOf(cause);
  if (code !== undefined) return NOT_CONNECTED_CODES.has(code);
  if (cause instanceof Error && NOT_CONNECTED_MESSAGES.has(cause.message)) return true;
  const attempts = (cause as { errors?: unknown } | null)?.errors;
  return (
    Array.isArray(attempts) &&
    attempts.length > 0 &&
    attempts.every((attempt) => NOT_CONNECTED_CODES.has(codeOf(attempt) ?? ''))
  );
};

const dispatch = async <A>(
  fetchImpl: FetchLike,
  endpoint: Endpoint,
  authorization: string,
  timeoutMs: number,
  call: OperationCall<A>,
): Promise<ClientResult<A>> => {
  const { effect } = call;
  let payload: string;
  try {
    payload = JSON.stringify(call.body);
  } catch {
    return fail({
      kind: 'invalid_request',
      effect,
      delivery: 'not_sent',
      message: 'The request could not be serialized.',
    });
  }

  // A function rather than a property test: `aborted` flips while this code is suspended.
  const callerAborted = (): boolean => call.signal?.aborted ?? false;
  if (callerAborted()) {
    return fail({
      kind: 'cancelled',
      effect,
      delivery: 'not_sent',
      message: 'The request was cancelled before it was sent.',
    });
  }

  // `AbortSignal.timeout` and `AbortSignal.any` are not dependable on every runtime this targets.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  call.signal?.addEventListener('abort', onCallerAbort, { once: true });

  // A timeout or a cancellation cannot say how far the request got, so neither claims it was not sent.
  // `answerStarted` is set once a status has arrived, after which nothing can have been unsent.
  const exchangeFailed = (error: unknown, answerStarted: boolean): ClientResult<A> => {
    if (timedOut) {
      return fail({
        kind: 'timeout',
        effect,
        delivery: 'unknown',
        message: 'The server did not answer in time.',
      });
    }
    if (callerAborted()) {
      return fail({
        kind: 'cancelled',
        effect,
        delivery: 'unknown',
        message: 'The request was cancelled.',
      });
    }
    return fail({
      kind: 'network',
      effect,
      delivery: !answerStarted && neverSent(error) ? 'not_sent' : 'unknown',
      message: 'The server could not be reached.',
    });
  };

  try {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(routeUrl(endpoint, call.route.path), {
        method: call.route.method,
        headers: {
          [AUTHORIZATION_HEADER]: authorization,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: payload,
        // Following a redirect would replay the credential at an address the server chose.
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      return exchangeFailed(error, false);
    }
    if (isRedirect(response)) {
      return fail(
        badResponse(
          effect,
          'The server redirected the request. Point the endpoint at the final address.',
          response.status,
        ),
      );
    }
    try {
      text = await response.text();
    } catch (error) {
      // The status arrived and the body did not: the server had the request, and its answer was lost.
      return exchangeFailed(error, true);
    }
    return readResponse(response.status, text, call);
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onCallerAbort);
  }
};

/** `redirect: 'manual'` can surface a redirect as an opaque response with status 0. */
const isRedirect = (response: Response): boolean =>
  response.type === 'opaqueredirect' ||
  (response.status !== 304 && response.status >= 300 && response.status < 400);

const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

const readResponse = <A>(status: number, text: string, call: OperationCall<A>): ClientResult<A> => {
  const parsed = parseJson(text);

  if (status === call.successStatus) {
    const decoded = parsed === undefined ? undefined : call.decode(parsed.value);
    if (decoded === undefined || Either.isLeft(decoded)) {
      return fail(
        badResponse(
          call.effect,
          'The server answered with a result this client could not read.',
          status,
        ),
      );
    }
    return succeed(decoded.right);
  }

  const envelope = parsed === undefined ? undefined : decodeApiErrorEnvelope(parsed.value);
  if (envelope === undefined || Either.isLeft(envelope)) {
    if (status < 400) {
      return fail(
        badResponse(
          call.effect,
          `The server answered ${status}, which this request does not expect.`,
          status,
        ),
      );
    }
    // A proxy's page or a bare status: the status is all there is to go on.
    return fail({
      kind: 'http',
      effect: call.effect,
      delivery: 'answered',
      status,
      message: `The server answered ${status}.`,
    });
  }
  const { code, message, details } = envelope.right.error;
  return fail({
    kind: 'http',
    effect: call.effect,
    delivery: 'answered',
    status,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });
};
