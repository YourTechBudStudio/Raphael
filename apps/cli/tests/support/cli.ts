/**
 * Running the CLI in-process, against a stub server.
 *
 * The stub is a real transport over a fake `fetch`, so every answer goes through the client's own
 * envelope decoding and failure classification exactly as a network answer would. Only the bytes the
 * "server" sends are invented here; what the CLI makes of them is the code under test.
 */

import { createTransport, isTransportRejection, type Transport } from '@raphael/client';
import { CONNECTION_ROUTES, PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from '../../src/distribution.ts';
import { run } from '../../src/main.ts';
import type { Connected, ConnectionInfo } from '../../src/shared/command.ts';

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StubRequest {
  readonly url: string;
  readonly body: unknown;
}

export interface StubServer {
  readonly connect: () => Connected;
  /** Every request that reached the fake `fetch`, in order. */
  readonly requests: StubRequest[];
}

/** A stand-in endpoint. Nothing listens there; the fake `fetch` answers instead. */
export const STUB_ENDPOINT = 'http://raphael.invalid';

/** Where the stub's connection says it came from: a saved login at a fixed, obviously fake path. */
export const STUB_CONNECTION: ConnectionInfo = {
  endpoint: STUB_ENDPOINT,
  source: 'saved_login',
  configFile: '/stub/raphael/config.json',
};

/** Long enough to satisfy the key policy, and obviously not a real credential. */
export const STUB_KEY = 'stub-key-0123456789abcdef0123456789';

/**
 * A transport whose `fetch` answers with `respond`.
 *
 * `respond` may throw to stand for a failed exchange, or return a promise that never settles to stand
 * for a server that does not answer; `timeoutMs` then bounds the wait.
 */
export const stubServer = (
  respond: (request: StubRequest) => Response | Promise<never>,
  timeoutMs?: number,
  options: {
    /**
     * Answer verification as a compatible Raphael server would, whatever `respond` does. On by
     * default, so a stubbed failure reads as that failure from a real server rather than as a server
     * that is not Raphael at all; a case about what verification finds turns it off.
     */
    readonly answerVerify?: boolean;
  } = {},
): StubServer => {
  const requests: StubRequest[] = [];
  const answer = (request: StubRequest): Response | Promise<never> =>
    options.answerVerify !== false &&
    new URL(request.url).pathname === CONNECTION_ROUTES.verify.path
      ? new Response(
          JSON.stringify({ protocolVersion: PROTOCOL_VERSION, raphaelVersion: version() }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      : respond(request);
  const connect = (): Connected => ({ transport: transport(), connection: STUB_CONNECTION });
  const transport = (): Transport => {
    const built = createTransport({
      endpoint: STUB_ENDPOINT,
      apiKey: STUB_KEY,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      fetch: async (url, init) => {
        const request: StubRequest = { url, body: JSON.parse(String(init.body)) as unknown };
        requests.push(request);
        if (init.signal !== null && init.signal !== undefined) {
          const { signal } = init;
          return Promise.race([
            Promise.resolve().then(() => answer(request)),
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          ]);
        }
        return answer(request);
      },
    });
    if (isTransportRejection(built)) throw new Error(built.message);
    return built;
  };
  return { connect, requests };
};

/** A Raphael error envelope on the given status. */
export const errorResponse = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A `connect` for cases that must never reach a server. */
export const neverConnect = (): Connected => {
  throw new Error('This case must not connect.');
};

export interface RunOptions {
  readonly connect?: () => Connected;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  /** Receives the handlers a command registers, so a case can deliver a signal to it. */
  readonly onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
}

/** Run the CLI's entry function with captured streams. */
export const runCli = async (argv: readonly string[], options: RunOptions = {}): Promise<Ran> => {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    streams: {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    environment: options.environment ?? {},
    platform: options.platform ?? process.platform,
    cwd: process.cwd(),
    // Remote commands watch for signals; none arrives unless a case delivers one.
    onSignal: options.onSignal ?? (() => () => {}),
    exit: () => {
      throw new Error('Remote commands must return their exit code');
    },
    connect: options.connect ?? neverConnect,
  });
  return { code, stdout, stderr };
};
