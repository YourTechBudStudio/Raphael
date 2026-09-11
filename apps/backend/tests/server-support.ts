import { connect } from 'node:net';

import { Effect, Exit, Scope } from 'effect';

import { ApiCredential } from '../src/infrastructure/config/credential.ts';
import { CONFIG_DEFAULTS, type BackendOptions } from '../src/infrastructure/config/options.ts';
import type { Deadlines } from '../src/infrastructure/http/deadlines.ts';
import { recordingLogger } from '../src/infrastructure/http/log.ts';
import { serve, type RunningServer } from '../src/server.ts';
import { tempDatabase, type TempDatabase } from './support.ts';

/**
 * Running a real server for a test.
 *
 * Every one of these listens on port 0, over a real on-disk database in a throwaway directory, and is
 * torn down before the test returns - the scope is closed in a `finally`, so a failing assertion
 * still releases the listener and the database. Nothing here starts a process that outlives the test.
 *
 * The key is a throwaway generated per server. It satisfies the length policy and appears in no
 * fixture, no log, and no committed file.
 */

export const testKey = (): string => `test-${'k'.repeat(40)}`;

export interface TestServer extends RunningServer {
  readonly key: string;
  readonly temp: TempDatabase;
  readonly logger: ReturnType<typeof recordingLogger>;
  readonly options: BackendOptions;
}

export const testOptions = (
  databasePath: string,
  overrides?: {
    readonly port?: number;
    readonly gcBatchSize?: number;
    readonly gcIntervalMinutes?: number;
  },
): BackendOptions => ({
  server: { host: '127.0.0.1', port: overrides?.port ?? 0 },
  database: { databasePath, busyTimeoutMs: CONFIG_DEFAULTS.busyTimeoutMs },
  idempotency: {
    gcIntervalMinutes: overrides?.gcIntervalMinutes ?? CONFIG_DEFAULTS.gcIntervalMinutes,
    gcBatchSize: overrides?.gcBatchSize ?? CONFIG_DEFAULTS.gcBatchSize,
  },
});

export interface WithServerOptions {
  /** Use this key instead of the generated one. Only for tests about the key policy itself. */
  readonly key?: string;
  readonly deadlines?: Partial<Deadlines>;
  readonly gcBatchSize?: number;
  readonly gcIntervalMinutes?: number;
  /** Seed the database before the server opens it. Ownership is exclusive, so it cannot be done after. */
  readonly seed?: (databasePath: string) => void;
}

export const withServer = async <T>(
  tag: string,
  body: (server: TestServer) => Promise<T>,
  options: WithServerOptions = {},
): Promise<T> => {
  const temp = tempDatabase(tag);
  options.seed?.(temp.file);

  const key = options.key ?? testKey();
  const logger = recordingLogger();
  const scope = Effect.runSync(Scope.make());

  try {
    const backendOptions = testOptions(temp.file, {
      ...(options.gcBatchSize === undefined ? {} : { gcBatchSize: options.gcBatchSize }),
      ...(options.gcIntervalMinutes === undefined
        ? {}
        : { gcIntervalMinutes: options.gcIntervalMinutes }),
    });
    const running = await Effect.runPromise(
      Scope.extend(
        serve({
          options: backendOptions,
          credential: ApiCredential.fromKey(key),
          logger,
          ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
        }),
        scope,
      ),
    );
    return await body({ ...running, key, temp, logger, options: backendOptions });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    temp.cleanup();
  }
};

/** A request against a running test server. Defaults to an authenticated JSON POST. */
export const call = async (
  server: Pick<TestServer, 'host' | 'port' | 'key'>,
  path: string,
  init: {
    readonly method?: string;
    readonly body?: string | Uint8Array;
    readonly headers?: Record<string, string>;
    readonly authorize?: boolean;
  } = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...init.headers,
  };
  if (init.authorize !== false) headers.authorization = `Bearer ${server.key}`;

  const response = await fetch(`http://${server.host}:${server.port}${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
};

/**
 * Send a request over a raw socket, byte for byte.
 *
 * Needed wherever `fetch` cannot express the request: duplicated header fields, which undici refuses
 * to send, and header bytes outside Latin-1, which it refuses outright. Returns the raw response.
 */
export const rawRequest = (
  server: Pick<TestServer, 'host' | 'port'>,
  request: string | Buffer,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(server.port, server.host, () => socket.write(request));
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    socket.once('close', () => resolve(received));
    socket.once('error', reject);
    setTimeout(() => socket.end(), 500).unref();
  });

/** The `error` object of an envelope, or a failed assertion naming what arrived instead. */
export const envelope = (
  payload: unknown,
): { code: string; message: string; details: Record<string, unknown> } => {
  const error = (payload as { error?: unknown } | undefined)?.error;
  if (error === undefined)
    throw new Error(`expected an error envelope, got ${JSON.stringify(payload)}`);
  return error as { code: string; message: string; details: Record<string, unknown> };
};
