/**
 * The probe, run against Node's fetch.
 *
 * This is not the phase 08 gate - the gate is the same probe run on a device through `expo/fetch`,
 * because that is the implementation whose behaviour is unknown. What this test establishes is that
 * the probe and its harness are sound: the fault conditions really occur, the redirect target's
 * counter really moves when something reaches it, and a passing check is therefore capable of
 * failing. A device result is only worth reading once this passes.
 *
 * The two real-server checks need a running Raphael server and are skipped without one, which is
 * recorded as skipped rather than quietly passing.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  startFakeRaphael,
  startFaultSource,
  startRedirectTarget,
} from './native-probe/harness.mjs';
import { runProbe } from './native-probe/probe.ts';

const HOST = '127.0.0.1';
const KEY = 'probe-key-not-a-real-credential';

const started = [];
after(async () => {
  await Promise.all(started.map((server) => server.stop()));
});

const listeners = async ({ raphael = false } = {}) => {
  const target = await startRedirectTarget(HOST);
  const source = await startFaultSource(HOST, target.port);
  started.push(target, source);
  if (!raphael) return { target, source, backend: undefined };
  const backend = await startFakeRaphael(HOST, KEY);
  started.push(backend);
  return { target, source, backend };
};

const configFor = ({ target, source, backend }) => ({
  fetch: globalThis.fetch,
  // Without a fake Raphael the two real-server checks have nothing to talk to, and report their own
  // failure rather than throwing. With one, they are exercised properly.
  backendEndpoint: `http://${HOST}:${(backend ?? source).port}`,
  apiKey: KEY,
  faultBase: `http://${HOST}:${source.port}`,
  targetBase: `http://${HOST}:${target.port}`,
});

describe('the native transport probe, proven against Node fetch', () => {
  it('refuses a redirect, and proves the target counter can move', async (t) => {
    const servers = await listeners();
    const checks = await runProbe(configFor(servers));
    const redirect = checks.find((check) => check.id === 'redirect');

    assert.ok(redirect, 'the redirect check ran');
    // The three legs matter individually: a zero target count is only evidence once the counter is
    // known to work and the probe is known to have run.
    assert.equal(
      redirect.evidence.reachedSource,
      true,
      'the probe reached the redirecting endpoint',
    );
    assert.equal(
      redirect.evidence.controlLanded,
      true,
      'the target recorded a request that really did reach it',
    );
    assert.equal(redirect.evidence.notFollowed, true, 'the redirect was not followed');
    assert.equal(redirect.evidence.credentialLanded, false, 'no credential reached the target');
    assert.equal(redirect.outcome, 'pass', redirect.detail);
    t.diagnostic(redirect.detail);
  });

  it('cuts off an overrunning body and the server sees the connection close', async (t) => {
    const servers = await listeners();
    const checks = await runProbe(configFor(servers));
    const oversize = checks.find((check) => check.id === 'oversize');

    assert.ok(oversize);
    assert.ok(oversize.evidence.record, 'the server saw this request');
    assert.equal(
      oversize.evidence.record.finished,
      false,
      'the server did not write the whole body',
    );
    assert.equal(oversize.evidence.record.closed, true, 'the server saw this connection close');
    assert.equal(oversize.outcome, 'pass', oversize.detail);
    t.diagnostic(
      `${oversize.detail} bytes written: ${String(oversize.evidence.record.bytesWritten)}`,
    );
  });

  it('times out on headers that never arrive, and cancels in both positions', async (t) => {
    const servers = await listeners();
    const checks = await runProbe(configFor(servers));

    for (const id of ['timeout', 'cancel-before-headers', 'cancel-mid-body']) {
      const found = checks.find((check) => check.id === id);
      assert.ok(found, `${id} ran`);
      assert.equal(found.outcome, 'pass', `${id}: ${found.detail}`);
      t.diagnostic(`${id}: ${found.detail}`);
    }
  });

  it('fails a cancellation whose request never reached the server', async (t) => {
    // The false positive a review reproduced, pinned. The harness used to keep one cumulative
    // `slowHeadersAborted` flag; the timeout check set it, and the cancellation check that ran
    // afterwards read it as evidence about its own request. This wrapper cancels client-side
    // exactly as a real cancellation does, while making sure the request never leaves - so the only
    // thing that can make the check pass is reading someone else's observation.
    const servers = await listeners();
    const config = configFor(servers);
    let slowHeaderCalls = 0;

    const swallowing = (url, init) => {
      if (typeof url === 'string' && url.includes('/slow-headers')) {
        slowHeaderCalls += 1;
        if (slowHeaderCalls > 1) {
          // Never dispatched. Resolves only when the caller aborts, the way an aborted fetch does.
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }
      }
      return globalThis.fetch(url, init);
    };

    const checks = await runProbe({ ...config, fetch: swallowing });
    const cancellation = checks.find((check) => check.id === 'cancel-before-headers');

    assert.ok(cancellation, 'the cancellation check ran');
    assert.equal(cancellation.evidence.clientFailure.kind, 'cancelled', 'the client did cancel');
    assert.equal(cancellation.evidence.record, undefined, 'the server never saw this request');
    assert.equal(
      cancellation.outcome,
      'fail',
      "a cancellation the server never saw must not pass on an earlier request's closure",
    );
    assert.ok(slowHeaderCalls > 1, 'the timeout check ran first, so a shared flag was already set');
    t.diagnostic(cancellation.detail);
  });

  it('gives up on an observation whose body never arrives', async (t) => {
    // The second boundedness gap a review found: the deadline used to be cleared when `fetch()`
    // resolved, which is when headers land. A listener that answered `GET /observed` and then
    // stalled its JSON left the read unbounded, so a device sat on "Running..." forever. This
    // listener answers and then says nothing, and the run must still finish.
    const servers = await listeners();
    const config = configFor(servers);

    const stalling = (url, init) => {
      if (String(url).includes('/observed')) {
        const body = new ReadableStream({
          start(controller) {
            // Headers are already out. The body arrives only if the read is aborted.
            init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
              once: true,
            });
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      return globalThis.fetch(url, init);
    };

    const startedAt = Date.now();
    const checks = await runProbe({ ...config, fetch: stalling, directFetchTimeoutMs: 300 });
    const elapsed = Date.now() - startedAt;

    // The point is that it finished at all. A generous ceiling still fails an unbounded read.
    assert.ok(elapsed < 20_000, `the probe must finish; it took ${String(elapsed)}ms`);
    assert.ok(checks.length > 0, 'the run reported what it learned');
    assert.ok(
      checks.every((check) => check.outcome === 'fail'),
      'no check may pass when its observations never arrived',
    );
    t.diagnostic(
      `finished in ${String(elapsed)}ms with ${String(checks.length)} checks, all failed`,
    );
  });

  it('passes the real-server checks against a server that answers the contract', async (t) => {
    // The gap that let a broken assertion ship: these two checks had never been allowed to succeed,
    // so `rejection` asserting a failure kind that does not exist looked exactly like a correct
    // check failing for want of a server. A refusal is an `api_error` carrying `unauthorized`.
    const servers = await listeners({ raphael: true });
    const checks = await runProbe(configFor(servers));

    const success = checks.find((check) => check.id === 'success');
    assert.ok(success);
    assert.equal(success.outcome, 'pass', success.detail);
    assert.equal(success.evidence.protocolVersion, 1);

    const rejection = checks.find((check) => check.id === 'rejection');
    assert.ok(rejection);
    assert.equal(
      rejection.evidence.failure.kind,
      'api_error',
      'a refusal is a structured api_error',
    );
    assert.equal(rejection.evidence.failure.status, 401);
    assert.equal(rejection.evidence.failure.error.code, 'unauthorized');
    assert.equal(rejection.outcome, 'pass', rejection.detail);
    t.diagnostic(`${success.detail} | ${rejection.detail}`);
  });

  it('reports the real-server checks as failures when no server is there', async (t) => {
    // Proving the probe does not manufacture a pass: with no Raphael server behind the endpoint,
    // success and rejection must both report failure rather than quietly returning nothing.
    const servers = await listeners();
    const checks = await runProbe(configFor(servers));

    for (const id of ['success', 'rejection']) {
      const found = checks.find((check) => check.id === id);
      assert.ok(found, `${id} ran`);
      assert.equal(found.outcome, 'fail', `${id} must not pass without a real server`);
      t.diagnostic(`${id}: ${found.detail}`);
    }
  });
});
