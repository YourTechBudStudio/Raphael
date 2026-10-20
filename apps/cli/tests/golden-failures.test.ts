import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { ClientFailure, Transport } from '@raphael/client';
import { API_ERROR_CODES, API_ERROR_STATUS } from '@raphael/contracts';

import { errorResponse, runCli, stubServer, STUB_ENDPOINT } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * How every server and client failure reads, through the whole CLI.
 *
 * Each case answers through a stub server and runs the real entry point, so the pinned output covers
 * the failure renderer, the exit code, and any guidance after it. Every case is run as a read and as
 * a write, because the two must come to read differently: after a write was sent, a failure cannot
 * claim that nothing happened.
 */

const failures = goldenSurface('failures');

after(() => assert.deepEqual(failures.strays(), []));

/** One read and one write, each a single request when it names its revision. */
const COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['read', ['get', '/work']],
  ['write', ['archive', '/work', '--revision', '1']],
];

describe('server error codes', () => {
  // Iterated from the contract's own catalog, so a new code without a golden file fails the build.
  for (const code of API_ERROR_CODES) {
    for (const [label, argv] of COMMANDS) {
      it(`renders ${code} on a ${label}`, async () => {
        // The server's sentence is a stand-in: these files pin what the CLI does around it.
        const server = stubServer(() =>
          errorResponse(API_ERROR_STATUS[code], code, `The server's sentence for ${code}.`),
        );
        const ran = await runCli(argv, { connect: server.connect });
        assert.equal(server.requests.length, 1);
        failures.expectRun(caseName('code', code, label), ran);
      });
    }
  }
});

type FailureKind = ClientFailure['kind'];

/**
 * How each kind of client failure is produced. Keyed by the client's own union, so a new kind without
 * a case fails the typecheck.
 */
const KINDS: Record<
  FailureKind,
  | { readonly respond: () => Response | Promise<never>; readonly timeoutMs?: number }
  | { readonly argv: readonly string[] }
  | { readonly stub: ClientFailure }
> = {
  network: {
    respond: () => {
      throw new TypeError('fetch failed');
    },
  },
  // The shortest timeout the client accepts, and an answer that never comes.
  timeout: { respond: () => new Promise<never>(() => {}), timeoutMs: 1_000 },
  // The CLI never hands the client an abort signal, so a cancelled request cannot be produced through
  // it. The client's own cancelled failure is rendered instead, to pin what the CLI would print.
  cancelled: { stub: { kind: 'cancelled', message: 'The request was cancelled.' } },
  // A request the shared decoder refuses never leaves; a blank title is one the CLI passes through.
  invalid_request: { argv: ['create', 'area', '/work', '--title', '   '] },
  // A proxy's page: a status with no Raphael envelope.
  http: {
    respond: () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
  },
  bad_response: {
    respond: () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
  },
};

/** A transport that fails every request with exactly this failure, without a network exchange. */
const failingTransport = (failure: ClientFailure) => (): Transport => ({
  endpoint: { base: STUB_ENDPOINT, origin: STUB_ENDPOINT },
  timeoutMs: 15_000,
  invoke: async () => ({ ok: false, failure }),
});

describe('client failure kinds', () => {
  for (const [kind, how] of Object.entries(KINDS) as Array<
    [FailureKind, (typeof KINDS)[FailureKind]]
  >) {
    if ('argv' in how) {
      it(`renders ${kind}`, async () => {
        const server = stubServer(() => {
          throw new Error('An invalid request must not be sent.');
        });
        const ran = await runCli(how.argv, { connect: server.connect });
        assert.equal(server.requests.length, 0);
        failures.expectRun(caseName('kind', kind), ran);
      });
      continue;
    }
    for (const [label, argv] of COMMANDS) {
      it(`renders ${kind} on a ${label}`, async () => {
        const connect =
          'stub' in how
            ? failingTransport(how.stub)
            : stubServer(how.respond, how.timeoutMs).connect;
        failures.expectRun(caseName('kind', kind, label), await runCli(argv, { connect }));
      });
    }
  }
});
