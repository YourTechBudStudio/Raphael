import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { createTransport, type FetchLike, type Transport } from '../shared/transport.ts';
import { verify } from './index.ts';

/**
 * What verification establishes, and the three things it refuses to confuse with each other.
 *
 * A server speaking a protocol this build does not understand, a server that cannot be reached, and
 * an answer that is not a Raphael answer are three different facts, and the whole value of this
 * module is that it keeps them apart. Each becomes a different failure, and none of them is ever
 * reported as a verified connection.
 *
 * Driven through the real transport over a stubbed `fetch`, following `nodes/update.test.ts`. A
 * hand-rolled `Transport` would assert nothing here: the boundary this phase cares about is between
 * an identifier that is merely *different* - which must decode, so it can be explained - and one
 * that is malformed, and that boundary lives in real response decoding.
 *
 * One thing these tests deliberately do **not** claim. `verify` returns the `PROTOCOL_VERSION`
 * constant rather than the decoded value, and no test can observe the difference: the compatibility
 * guard is strict equality, so anything reaching the success branch is already equal to the
 * constant. What protects that line is the type - `VerifiedConnection.protocolVersion` is narrower
 * than the received type, so the compiler refuses the decoded value. Do not delete that narrowing on
 * the belief that something here covers it.
 */

const KEY = 'a'.repeat(32);

const transportOver = (fetchImpl: FetchLike): Transport =>
  createTransport({
    endpoint: 'http://127.0.0.1:1/',
    apiKey: KEY,
    fetch: fetchImpl,
  }) as Transport;

/** A server that answers 200 with whatever it is given. */
const answering = (payload: unknown): Transport =>
  transportOver(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

describe('verifying a connection', () => {
  it('accepts a server speaking this protocol', async () => {
    const result = await verify(answering({ protocolVersion: PROTOCOL_VERSION }));

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.protocolVersion, PROTOCOL_VERSION);
  });

  it('explains a server that is behind, naming both identifiers', async () => {
    const result = await verify(answering({ protocolVersion: '2026-09-10' }));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      {
        kind: result.failure.kind,
        reason: 'reason' in result.failure ? result.failure.reason : undefined,
        mutationOutcome: result.failure.mutationOutcome,
      },
      {
        kind: 'invalid_response',
        reason: 'incompatible_protocol',
        mutationOutcome: 'not_applicable',
      },
    );
    assert.ok(result.failure.message.includes('speaks protocol 2026-09-10;'));
    assert.ok(result.failure.message.includes(`understands ${PROTOCOL_VERSION}.`));
    assert.match(result.failure.message, /Update the server\./u);
  });

  it('explains a server that is ahead, and a server predating the date-based scheme', async () => {
    // Two shapes of "different", and the failure is the same shape for both. The legacy number is
    // the case the mismatch wording exists for: a numeric identifier decodes purely so that this
    // sentence can be said about it.
    for (const [protocolVersion, guidance] of [
      ['2026-10-01', /Update Raphael here\./u],
      [1, /Update the server\./u],
    ] as const) {
      const result = await verify(answering({ protocolVersion }));

      assert.equal(result.ok, false, `${protocolVersion} must not verify`);
      if (result.ok) return;
      assert.equal(result.failure.kind, 'invalid_response');
      assert.equal(
        'reason' in result.failure ? result.failure.reason : undefined,
        'incompatible_protocol',
      );
      assert.equal(result.failure.mutationOutcome, 'not_applicable');
      // In sentence position: a bare search for `1` would pass on the current date alone.
      assert.ok(result.failure.message.includes(`speaks protocol ${protocolVersion};`));
      assert.ok(result.failure.message.includes(`understands ${PROTOCOL_VERSION}.`));
      assert.match(result.failure.message, guidance);
    }
  });

  it('does not turn a server it could not reach into a protocol mismatch', async () => {
    // The distinction the module header exists to protect. An unreachable server has said nothing
    // about its protocol, and reporting one as the other would send someone off to update a build
    // that was never the problem.
    const result = await verify(transportOver(() => Promise.reject(new TypeError('fetch failed'))));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'transport');
    assert.equal('reason' in result.failure, false);
  });

  it('does not turn an answer that is not a Raphael answer into a protocol mismatch', async () => {
    // A captive portal or a proxy answers 200 with something else entirely. That is a decoding
    // failure, not a server speaking a protocol from the future.
    for (const payload of [{ protocolVersion: '2026-13-01' }, { protocolVersion: 0 }, {}]) {
      const result = await verify(answering(payload));

      assert.equal(result.ok, false, JSON.stringify(payload));
      if (result.ok) return;
      assert.equal(result.failure.kind, 'invalid_response');
      assert.equal(
        'reason' in result.failure ? result.failure.reason : undefined,
        'invalid_payload',
        'a malformed identifier is not a mismatch',
      );
    }
  });
});
