/**
 * The phase 08 native transport gate.
 *
 * The shared client's security and correctness guarantees - refusing redirects with a credential
 * attached, reading a body incrementally under a ceiling, cancelling in flight - are properties of
 * the fetch implementation underneath it as much as of the client's own code. Every one of them is
 * covered by tests against Node's fetch, and none of that says anything about `expo/fetch` on a
 * device. This runs the same checks through whichever implementation it is handed, so the Node run
 * proves the harness and the device run proves the runtime.
 *
 * Three rules this file follows, all learned the hard way:
 *
 * 1. A check that can pass because nothing ran is not evidence. The redirect check proves the target
 *    counter works by incrementing it deliberately before trusting that it stayed still.
 * 2. What the client reports and what the server saw are different facts. Both are recorded.
 * 3. An observation must be attributable to the request being judged. This rule was added after a
 *    review reproduced a false positive: the harness kept one cumulative `slowHeadersAborted` flag,
 *    the timeout check set it, and the cancellation check that ran afterwards read it as evidence
 *    about its own request - so a cancellation that never reached the server could still pass. Every
 *    fault request now carries an id and is judged only by the record filed against that id.
 *
 * Test-only. Nothing in `src/` imports this outside the temporary development probe screen, which is
 * removed before the phase closes.
 */

import { createTransport, isTransportRejection, type FetchLike } from '@raphael/client';
import { verify } from '@raphael/client/connection';

export type ProbeOutcome = 'pass' | 'fail';

export interface ProbeCheck {
  readonly id: string;
  readonly title: string;
  readonly outcome: ProbeOutcome;
  /** One sentence a human can read without knowing the transport's internals. */
  readonly detail: string;
  /** What was actually observed, client-side and server-side. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ProbeConfig {
  /** The implementation under test. The whole point of the probe. */
  readonly fetch: FetchLike;
  /** A running Raphael server, for the two checks a real server must answer. */
  readonly backendEndpoint: string;
  readonly apiKey: string;
  /** Controlled listeners, for the conditions a real server cannot be asked to produce. */
  readonly faultBase: string;
  readonly targetBase: string;
  /** Overrides the direct-fetch deadline. Exists so a test can exercise it in milliseconds. */
  readonly directFetchTimeoutMs?: number;
}

const ECHO = { route: { method: 'POST', path: '' } as const, successStatus: 200 };

/** Long enough that a slow emulator link is not mistaken for an unreachable listener. */
const DIRECT_FETCH_TIMEOUT_MS = 10_000;

let sequence = 0;

/** Unique per request within a run, and readable in a server log. */
const nextId = (label: string): string => {
  sequence += 1;
  return `${label}-${String(sequence)}-${Math.random().toString(36).slice(2, 8)}`;
};

export interface FaultRecord {
  readonly id: string | null;
  readonly route: string;
  readonly closed: boolean;
  readonly finished: boolean;
  readonly bytesWritten: number;
}

const recordsOf = (observed: Record<string, unknown>): FaultRecord[] =>
  (observed.records as FaultRecord[] | undefined) ?? [];

export interface TargetHit {
  readonly id: string | null;
  readonly path: string;
  readonly hadAuthorization?: boolean;
}

const hitsOf = (observed: Record<string, unknown>): TargetHit[] =>
  (observed.hits as TargetHit[] | undefined) ?? [];

const recordFor = (observed: Record<string, unknown>, id: string): FaultRecord | undefined =>
  recordsOf(observed).find((record) => record.id === id);

/** Never decodes successfully. Every fault check fails before a body could be decoded anyway. */
const decodeNothing = () => ({ ok: false as const, issue: { path: [], message: 'probe' } });

const transportFor = (config: ProbeConfig, base: string, timeoutMs?: number) => {
  const transport = createTransport({
    endpoint: base,
    apiKey: config.apiKey,
    fetch: config.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (isTransportRejection(transport)) {
    throw new Error(`probe could not build a transport for ${base}: ${transport.message}`);
  }
  return transport;
};

const invokeFault = (
  config: ProbeConfig,
  path: string,
  id: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
) =>
  transportFor(config, config.faultBase, options.timeoutMs).invoke({
    ...ECHO,
    // The id travels in the query string, which `routeUrl` appends untouched, so the server can file
    // its observations against this request rather than against whatever ran most recently.
    route: { method: 'POST', path: `${path}?id=${encodeURIComponent(id)}` },
    body: {},
    decode: decodeNothing as never,
    mutating: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

/**
 * Every direct fetch is bounded *through reading its body*, not merely until headers arrive. The
 * transport bounds its own requests; these bypass it, so they need their own deadline.
 *
 * The consumer runs inside the deadline rather than after it. An earlier version cleared the timer
 * the moment `fetch()` resolved - which is when headers land, not when the body finishes - so a
 * listener that answered and then stalled its JSON left the read unbounded and the device showing
 * "Running..." indefinitely. The abort signal stays live until the caller has what it asked for, so
 * a stalled body errors the read instead of hanging it.
 */
const withDeadline = async <A>(
  config: ProbeConfig,
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<A>,
): Promise<A> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.directFetchTimeoutMs ?? DIRECT_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await config.fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
};

const observedAt = (config: ProbeConfig, base: string): Promise<Record<string, unknown>> =>
  withDeadline(
    config,
    `${base}/observed`,
    { method: 'GET' },
    async (response) => (await response.json()) as Record<string, unknown>,
  );

/**
 * A server-side observation can lag the client result: the client learns the request is over when it
 * abandons the read, and the socket teardown the server sees happens a moment later. Polling for a
 * bounded period asks the right question - did the server *ever* see it - rather than asserting on
 * whichever moment the client happened to return. It still fails if the closure never arrives, which
 * is the failure worth catching: a cancelled request that leaves the server writing.
 */
const observedUntil = async (
  config: ProbeConfig,
  base: string,
  settled: (observed: Record<string, unknown>) => boolean,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await observedAt(config, base);
  while (!settled(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await observedAt(config, base);
  }
  return latest;
};

const failureOf = (result: { ok: boolean } & Record<string, unknown>) =>
  (result as { failure?: Record<string, unknown> }).failure ?? {};

const check = (
  id: string,
  title: string,
  passed: boolean,
  detail: string,
  evidence: Record<string, unknown>,
): ProbeCheck => ({ id, title, outcome: passed ? 'pass' : 'fail', detail, evidence });

/**
 * Success and structured rejection, against the real server.
 */
const realServerChecks = async (config: ProbeConfig): Promise<ProbeCheck[]> => {
  const good = await verify(transportFor(config, config.backendEndpoint));
  const success = check(
    'success',
    'A verified connection over the real server',
    good.ok,
    good.ok
      ? `Verified, protocol version ${String(good.value.protocolVersion)}.`
      : `Verification failed: ${String(failureOf(good).message ?? 'no message')}`,
    good.ok ? { protocolVersion: good.value.protocolVersion } : { failure: failureOf(good) },
  );

  const wrong = createTransport({
    endpoint: config.backendEndpoint,
    apiKey: `${config.apiKey}-not-the-key`,
    fetch: config.fetch,
  });
  if (isTransportRejection(wrong)) {
    throw new Error('probe could not build a transport for the rejection check');
  }
  const refused = await verify(wrong);
  const failure = failureOf(refused);
  // A refused credential is an `api_error` carrying the server's `unauthorized` code - there is no
  // `unauthorized` failure *kind*, and an earlier version of this check asserted one, so it could
  // never pass. It survived because the Node suite only ever pinned that this check fails with no
  // real server behind the endpoint, which it did, for the wrong reason. The device run is what
  // exposed it. The check now names all three facts it actually depends on.
  const classified = failure.error as { readonly code?: string } | undefined;
  const structured =
    !refused.ok &&
    failure.kind === 'api_error' &&
    failure.status === 401 &&
    classified?.code === 'unauthorized';
  const rejection = check(
    'rejection',
    'A refused key arrives as a structured failure',
    structured,
    refused.ok
      ? 'A wrong key was accepted, which is a server problem, not a transport one.'
      : structured
        ? 'Refused as a 401 unauthorized api_error, resolved rather than thrown.'
        : `Refused as ${String(failure.kind)}${failure.status === undefined ? '' : ` (${String(failure.status)})`}, which is not the structured refusal this expects.`,
    { failure },
  );

  return [success, rejection];
};

/**
 * The credential-disclosure check. Three legs, in this order, because the third is only meaningful
 * once the first two have established that the probe ran and that the counter moves.
 */
const redirectCheck = async (config: ProbeConfig): Promise<ProbeCheck> => {
  const controlId = nextId('redirect-control');
  const probeId = nextId('redirect');

  // Leg 2 first: prove the target records a request that really does reach it. Without this, a
  // target that saw nothing is indistinguishable from a target that cannot see anything.
  await withDeadline(
    config,
    `${config.targetBase}/landed?id=${controlId}`,
    { method: 'POST', body: '{}' },
    // Drained rather than abandoned: an unread body holds the connection open, and reading it is
    // what keeps this call inside the deadline.
    async (response) => {
      await response.text();
    },
  );
  const afterControl = await observedAt(config, config.targetBase);
  const controlLanded = hitsOf(afterControl).some((hit) => hit.id === controlId);

  // Leg 3: the request under test. The harness carries its id onto the redirect, so a landing is
  // attributable to this request rather than to anything else that reached the target.
  const result = await invokeFault(config, '/redirect', probeId);
  const afterProbe = await observedAt(config, config.targetBase);
  const source = await observedAt(config, config.faultBase);

  // Leg 1: this request, not merely some request, reached the redirecting endpoint.
  const reachedSource = recordFor(source, probeId) !== undefined;
  const landed = hitsOf(afterProbe).filter((hit) => hit.id === probeId);
  const notFollowed = landed.length === 0;
  const credentialLanded = landed.some((hit) => hit.hadAuthorization === true);
  const failure = failureOf(result);
  const refused = !result.ok && failure.reason === 'redirect_refused';

  return check(
    'redirect',
    'A redirect is refused before the credential is replayed',
    reachedSource && controlLanded && notFollowed && refused,
    !reachedSource
      ? 'The probe never reached the redirecting endpoint, so this check proves nothing.'
      : !controlLanded
        ? 'The target did not record a request that really did reach it, so a silent target means nothing.'
        : credentialLanded
          ? 'THE CREDENTIAL REACHED THE REDIRECT TARGET.'
          : !notFollowed
            ? 'THE REDIRECT WAS FOLLOWED. This request reached the redirect target.'
            : refused
              ? 'Refused as redirect_refused; this request never reached the target.'
              : `The target was not reached, but the client reported ${String(failure.reason ?? failure.kind)} rather than a redirect refusal.`,
    {
      probeId,
      reachedSource,
      controlLanded,
      notFollowed,
      credentialLanded,
      clientFailure: failure,
      landings: landed,
    },
  );
};

/**
 * The ceiling, checked on both sides: the client must stop reading, and the server must see the
 * connection go away rather than run to completion.
 */
const oversizeCheck = async (config: ProbeConfig): Promise<ProbeCheck> => {
  const id = nextId('oversize');
  // A generous timeout: the point is the size ceiling, and a timeout firing first would answer a
  // different question.
  const result = await invokeFault(config, '/oversize', id, { timeoutMs: 120_000 });
  const observed = await observedUntil(config, config.faultBase, (seen) => {
    const record = recordFor(seen, id);
    return record !== undefined && (record.closed || record.finished);
  });
  const record = recordFor(observed, id);
  const failure = failureOf(result);
  const stoppedByCeiling = !result.ok && failure.reason === 'response_too_large';
  const serverSawClosure = record !== undefined && record.closed && !record.finished;

  return check(
    'oversize',
    'An overrunning body is cut off, and the connection actually closes',
    stoppedByCeiling && serverSawClosure,
    record === undefined
      ? 'The server never saw this request, so there is nothing to judge.'
      : stoppedByCeiling
        ? serverSawClosure
          ? 'Refused at the ceiling and the server saw this connection close before it finished writing.'
          : 'The client refused it, but the server wrote the whole body - nothing was actually cut off.'
        : `The client reported ${String(failure.reason ?? failure.kind)} rather than a size refusal.`,
    { id, clientFailure: failure, record },
  );
};

const timeoutCheck = async (config: ProbeConfig): Promise<ProbeCheck> => {
  const id = nextId('timeout');
  const result = await invokeFault(config, '/slow-headers', id, { timeoutMs: 1_000 });
  const observed = await observedAt(config, config.faultBase);
  const record = recordFor(observed, id);
  const failure = failureOf(result);
  const timedOut = !result.ok && failure.kind === 'timeout';

  return check(
    'timeout',
    'Headers that never arrive time out',
    timedOut && record !== undefined,
    record === undefined
      ? 'The server never saw this request, so a timeout here says nothing about stalled headers.'
      : timedOut
        ? 'Timed out as configured, against a request the server confirms it received.'
        : `Reported ${String(failure.kind ?? 'success')} instead of a timeout.`,
    { id, clientFailure: failure, record },
  );
};

const cancellationChecks = async (config: ProbeConfig): Promise<ProbeCheck[]> => {
  const cancelled = async (
    id: string,
    route: string,
    title: string,
    checkId: string,
    waitMs: number,
  ): Promise<ProbeCheck> => {
    const controller = new AbortController();
    const pending = invokeFault(config, route, id, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    controller.abort();
    const result = await pending;

    // This request's own record, never a flag some earlier request set. The reproduction that
    // prompted this: the timeout check had already stalled a `/slow-headers` request, and reading a
    // shared flag let a cancellation that never left the device report that the server saw it close.
    const observed = await observedUntil(config, config.faultBase, (seen) => {
      const record = recordFor(seen, id);
      return record !== undefined && record.closed;
    });
    const record = recordFor(observed, id);
    const failure = failureOf(result);
    const reportedCancelled = !result.ok && failure.kind === 'cancelled';
    const serverSawClosure = record !== undefined && record.closed;

    return check(
      checkId,
      title,
      reportedCancelled && serverSawClosure,
      record === undefined
        ? 'The server never saw this request, so its cancellation proves nothing about the connection.'
        : reportedCancelled
          ? serverSawClosure
            ? 'Cancelled, and the server saw this connection go away.'
            : 'The client reported cancellation but the server never saw this connection close.'
          : `Reported ${String(failure.kind ?? 'success')} instead of cancellation.`,
      { id, clientFailure: failure, record },
    );
  };

  return [
    await cancelled(
      nextId('cancel-headers'),
      '/slow-headers',
      'Cancelling before headers arrive stops the request',
      'cancel-before-headers',
      150,
    ),
    await cancelled(
      nextId('cancel-body'),
      '/slow-body',
      'Cancelling while the body is streaming stops the read',
      'cancel-mid-body',
      300,
    ),
  ];
};

/**
 * Finite, sequential, and it always returns a result per check rather than throwing part-way, so a
 * device run reports what it learned even when one condition behaves unexpectedly.
 */
export const runProbe = async (config: ProbeConfig): Promise<ProbeCheck[]> => {
  const checks: ProbeCheck[] = [];
  const stages: [string, () => Promise<ProbeCheck[]>][] = [
    ['real-server', () => realServerChecks(config)],
    ['redirect', async () => [await redirectCheck(config)]],
    ['oversize', async () => [await oversizeCheck(config)]],
    ['timeout', async () => [await timeoutCheck(config)]],
    ['cancellation', () => cancellationChecks(config)],
  ];

  for (const [id, run] of stages) {
    try {
      checks.push(...(await run()));
    } catch (error) {
      checks.push(
        check(id, `${id} could not run`, false, 'The check itself failed to complete.', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return checks;
};
