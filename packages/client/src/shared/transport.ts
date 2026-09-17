/**
 * The one place a Raphael request is actually sent.
 *
 * Everything security-relevant about talking to a server lives here so that no capability can get it
 * differently: the credential is captured in a closure and never travels in a payload or a cache key,
 * redirects are refused rather than followed, ambient cookies are off, the response is consumed under
 * a byte ceiling before anything parses it, and one timer bounds the whole exchange rather than just
 * the wait for headers.
 *
 * The fetch implementation is injected and there is no fallback to a global. That is not ceremony:
 * this transport requires a response body it can read incrementally, and "whatever `fetch` happens to
 * exist" is how a build silently acquires an implementation that buffers the whole response first.
 * A caller states what it is using; if that implementation cannot stream, requests fail loudly.
 */

import {
  API_ERROR_STATUS,
  SHUTTING_DOWN_REASON,
  classifyApiError,
  decodeApiErrorEnvelope,
  isApiErrorCode,
  projectRecoveryDetails,
  type ApiErrorCode,
  type Decoder,
} from '@raphael/contracts';
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
  type InvalidResponseReason,
  type MutationOutcome,
} from './failure.ts';

/**
 * The client's ceiling on a response body.
 *
 * Not a statement about how large a stored entity may be - it is a safety bound on how much this
 * process will read from a server before giving up. It has to clear the largest legitimate response
 * by a comfortable margin: a `list` at `LIST_LIMIT_MAX` of 500 summaries, each carrying a 4,000
 * code-point description that JSON escaping can expand to roughly 24 KB, plus tags and a title,
 * reaches about 15.7 MiB before a single body is involved. A `get` returning a large Markdown body as
 * TipTap expands further, since conversion produces more JSON than the Markdown that was submitted
 * under the 1 MiB request budget.
 *
 * Exceeding it is a failure, never a truncation: half a response is not a smaller response.
 */
export const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/** The whole exchange, not just the wait for headers. */
export const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * The shape of `fetch` this transport uses. Deliberately minimal: it names what is required rather
 * than accepting a full DOM `fetch` type, so an implementation that satisfies this much is enough.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  /** Absolute URL of the server, optionally carrying a base path. */
  readonly endpoint: string;
  /** The full-access API key. Captured in a closure and never exposed again. */
  readonly apiKey: string;
  /** Required. See the note above about global fetch. */
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
  /** Already decoded and detached by the capability. Serialized here, once. */
  readonly body: unknown;
  readonly decode: Decoder<A>;
  /** The status a successful answer must carry. Anything else is not a success. */
  readonly successStatus: number;
  /** Whether this operation creates or changes something, which decides how uncertainty is reported. */
  readonly mutating: boolean;
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
  // not refused here and will surface as a transport failure at the first request instead.
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

const uncertainty = (mutating: boolean): MutationOutcome =>
  mutating ? 'unknown' : 'not_applicable';

const definite = (mutating: boolean): MutationOutcome => (mutating ? 'rejected' : 'not_applicable');

/**
 * The same sentence for both ways a fetch implementation can fail to offer a readable body: no `body`
 * property at all, or one without `getReader`. Both mean the implementation cannot stream, which is a
 * fact about the client's environment rather than about the server's answer.
 */
const unsupportedFetch = (mutating: boolean): ClientFailure => ({
  kind: 'unsupported_fetch',
  mutationOutcome: uncertainty(mutating),
  message:
    'The configured fetch implementation does not provide a readable response body. Raphael reads ' +
    'responses incrementally under a size limit and will not buffer one first.',
});

const invalidResponse = (
  reason: InvalidResponseReason,
  message: string,
  mutating: boolean,
  status?: number,
): ClientFailure => ({
  kind: 'invalid_response',
  reason,
  mutationOutcome: uncertainty(mutating),
  message,
  ...(status === undefined ? {} : { status }),
});

/**
 * Read a response body under a hard ceiling, aborting the moment it is exceeded.
 *
 * The counting is of bytes the reader actually delivers, which is after any transparent
 * decompression the implementation performed - so a small compressed body that expands enormously is
 * caught here rather than after it has been buffered. Checking `Content-Length` instead would bound
 * neither reception nor memory: the header can be absent, can describe compressed bytes, and can lie.
 */
const readBounded = async (
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | 'too_large'> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return 'too_large';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

const dispatch = async <A>(
  fetchImpl: FetchLike,
  endpoint: Endpoint,
  authorization: string,
  timeoutMs: number,
  call: OperationCall<A>,
): Promise<ClientResult<A>> => {
  // Serialize before anything else. From here on the request is a string: a caller mutating the
  // object it handed in cannot change what is on the wire, and a retry can reuse this exact payload.
  let payload: string;
  try {
    payload = JSON.stringify(call.body);
  } catch {
    return fail({
      kind: 'invalid_request',
      mutationOutcome: 'not_dispatched',
      message: 'The request could not be serialized.',
      path: [],
    });
  }

  // Read through a function rather than a property test. `aborted` is external mutable state that
  // flips while this code is suspended at an `await`, and a direct comparison lets control-flow
  // analysis narrow the second check to "impossible" on the strength of the first.
  const callerAborted = (): boolean => call.signal?.aborted ?? false;

  if (callerAborted()) {
    return fail({
      kind: 'cancelled',
      mutationOutcome: 'not_dispatched',
      message: 'The request was cancelled before it was sent.',
    });
  }

  // One controller, composed by hand. `AbortSignal.timeout` and `AbortSignal.any` are not dependable
  // on every runtime this package targets, and the composition is four lines.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  call.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onCallerAbort);
  };

  try {
    let response: Response;
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
        // No ambient cookies, in either direction.
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch {
      // Opaque by construction. See the note in failure.ts about why this is not narrowed.
      if (timedOut) {
        return fail({
          kind: 'timeout',
          mutationOutcome: uncertainty(call.mutating),
          message: 'The server did not answer in time.',
          timeoutMs,
        });
      }
      if (callerAborted()) {
        return fail({
          kind: 'cancelled',
          mutationOutcome: uncertainty(call.mutating),
          message: 'The request was cancelled after it was sent.',
        });
      }
      return fail({
        kind: 'transport',
        mutationOutcome: uncertainty(call.mutating),
        message: 'The server could not be reached.',
      });
    }

    return await readResponse(response, call, timeoutMs, () => timedOut, callerAborted);
  } finally {
    release();
  }
};

const readResponse = async <A>(
  response: Response,
  call: OperationCall<A>,
  timeoutMs: number,
  timedOut: () => boolean,
  callerAborted: () => boolean,
): Promise<ClientResult<A>> => {
  const { mutating } = call;

  // A redirect is refused before the body is touched. `redirect: 'manual'` surfaces one as an opaque
  // response whose status can be 0, so status alone is not the test.
  const isRedirect = response.status !== 304 && response.status >= 300 && response.status < 400;
  if (response.type === 'opaqueredirect' || isRedirect) {
    return fail(
      invalidResponse(
        'redirect_refused',
        'The server redirected the request. Raphael does not follow redirects with a credential attached; ' +
          'point the endpoint at the final address.',
        mutating,
        response.status,
      ),
    );
  }

  // Statuses that carry no body are not part of any operation's contract here, and 304 is not a
  // redirect - it is an answer this client never asked for.
  if (response.status === 204 || response.status === 304) {
    return fail(
      invalidResponse(
        'unexpected_status',
        `The server answered ${response.status}, which is not an answer this operation defines.`,
        mutating,
        response.status,
      ),
    );
  }

  // `undefined` and `null` are different facts and must not collapse into one. A spec-compliant
  // response carries `body: null` when there is genuinely nothing to read, which is a broken answer
  // from the server. An implementation that never defines `body` at all is not answering that
  // question - it is saying it does not stream - and it is checked first because dereferencing it
  // below would throw a `TypeError` out of this function, which is called outside the `catch` that
  // builds transport failures. That escapes the failure model every caller reads and surfaces as a
  // rejected promise instead of a result.
  if (response.body === undefined) {
    return fail(unsupportedFetch(mutating));
  }
  if (response.body === null) {
    return fail(
      invalidResponse(
        'empty_response',
        'The server answered with no body where a result was required.',
        mutating,
        response.status,
      ),
    );
  }
  if (typeof response.body.getReader !== 'function') {
    return fail(unsupportedFetch(mutating));
  }

  let bytes: Uint8Array | 'too_large';
  try {
    bytes = await readBounded(response.body, RESPONSE_MAX_BYTES);
  } catch {
    if (timedOut()) {
      return fail({
        kind: 'timeout',
        mutationOutcome: uncertainty(mutating),
        message: 'The response did not finish arriving in time.',
        timeoutMs,
      });
    }
    if (callerAborted()) {
      return fail({
        kind: 'cancelled',
        mutationOutcome: uncertainty(mutating),
        message: 'The request was cancelled while the response was arriving.',
      });
    }
    return fail({
      kind: 'transport',
      mutationOutcome: uncertainty(mutating),
      message: 'The connection failed while the response was arriving.',
    });
  }

  if (bytes === 'too_large') {
    return fail(
      invalidResponse(
        'response_too_large',
        `The response exceeded the ${RESPONSE_MAX_BYTES}-byte limit this client will read. Ask for a ` +
          'smaller page with --limit, or fetch entities individually.',
        mutating,
        response.status,
      ),
    );
  }
  if (bytes.byteLength === 0) {
    return fail(
      invalidResponse(
        'empty_response',
        'The server answered with an empty body where a result was required.',
        mutating,
        response.status,
      ),
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(
      invalidResponse(
        'invalid_utf8',
        'The response was not valid UTF-8.',
        mutating,
        response.status,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the body, so it is discarded rather than reported.
    //
    // Which failure this is depends on the status. On the success status the body *was* the answer,
    // so "not JSON" is the whole story. On any other status something refused the request and did so
    // unintelligibly - a proxy's HTML sign-in page, most often - and reporting that as a JSON syntax
    // problem would send someone to look at Raphael instead of at what is in front of it.
    return fail(
      response.status === call.successStatus
        ? invalidResponse(
            'malformed_json',
            'The response was not valid JSON.',
            mutating,
            response.status,
          )
        : invalidResponse(
            'unrecognized_error',
            `The server answered ${response.status} with something this client could not read as an error. ` +
              'Check whether a proxy in front of Raphael answered instead.',
            mutating,
            response.status,
          ),
    );
  }

  if (response.status === call.successStatus) {
    const decoded = call.decode(parsed);
    if (Either.isLeft(decoded)) {
      return fail(
        invalidResponse(
          'invalid_payload',
          'The server answered with a result this client could not read.',
          mutating,
          response.status,
        ),
      );
    }
    return succeed(decoded.right);
  }

  return fail(classifyErrorResponse(parsed, response.status, mutating));
};

/**
 * Turn a non-success response into a failure, and decide what it establishes about a mutation.
 *
 * The rule: a *decoded, status-consistent* envelope carrying a known code is the server stating it
 * refused, and nothing was created or changed. Two exceptions, both deliberate and both conservative:
 *
 * - `internal_error` is `unknown`. Today's create operation does its response self-check and its
 *   replay recording inside the same write transaction, so an internal failure provably rolls back.
 *   A client cannot verify a server-internal commit boundary, that boundary can change under it, and
 *   the cost of being wrong is a silent duplicate.
 * - `storage_busy` is `unknown`, *except* with the documented `shutting_down` reason, which the
 *   transport produces before any operation runs. Note that the generic `storage_busy` message says
 *   the request was not applied; that prose is the server's and it is not what a client reports when
 *   its own classification says otherwise.
 */
const classifyErrorResponse = (
  parsed: unknown,
  status: number,
  mutating: boolean,
): ClientFailure => {
  const envelope = decodeApiErrorEnvelope(parsed);
  if (Either.isLeft(envelope)) {
    return invalidResponse(
      'unrecognized_error',
      `The server answered ${status} with something this client could not read as an error.`,
      mutating,
      status,
    );
  }

  const classified = classifyApiError(envelope.right);

  if (classified.kind === 'known') {
    const expected = API_ERROR_STATUS[classified.code];
    if (expected !== status) {
      // A proxy or a confused server has broken the contract; neither field can now be trusted, so
      // no guess is made about which one was right.
      return invalidResponse(
        'inconsistent_error',
        `The server answered ${status} with a "${classified.code}" error, which it does not use that status for.`,
        mutating,
        status,
      );
    }
  }

  const details = projectRecoveryDetails(classified.code, classified.details);
  const outcome: MutationOutcome =
    classified.kind === 'known' && establishesNonApplication(classified.code, details.reason)
      ? definite(mutating)
      : uncertainty(mutating);

  return {
    kind: 'api_error',
    status,
    error: classified,
    details,
    mutationOutcome: outcome,
    // The server's own prose is not repeated when this client's classification contradicts it. The
    // generic `storage_busy` message reads "The request was not applied; try again" - a claim about
    // one transaction, not about the whole exchange - and printing it beside an `unknown` outcome
    // would give a person two incompatible answers and invite an unsafe repeat. The server's text
    // stays available, attributed, on `error.message`.
    message:
      outcome === 'unknown'
        ? 'The server did not confirm whether this was applied.'
        : classified.message,
  };
};

const establishesNonApplication = (code: ApiErrorCode, reason: string | undefined): boolean => {
  if (!isApiErrorCode(code)) return false;
  switch (code) {
    case 'internal_error':
      return false;
    case 'storage_busy':
      return reason === SHUTTING_DOWN_REASON;
    default:
      return true;
  }
};
