import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ExecutionStrategy, Effect, Layer, Runtime, Scope } from 'effect';

import {
  validateOptions,
  type ApiCredential,
  type BackendOptions,
} from './infrastructure/config/index.ts';
import {
  DatabaseUnavailableError,
  Db,
  MigrationHistoryError,
  layer as databaseLayer,
} from './infrastructure/database/index.ts';
import { buildApp } from './infrastructure/http/app.ts';
import { consoleLogger, type Logger } from './infrastructure/http/log.ts';
import type { OperationRoute } from './infrastructure/http/operation.ts';
import { connectionRoutes } from './modules/connection/index.ts';
import { nodeRoutes } from './modules/nodes/routes.ts';

/**
 * One scoped resource. The port is bound first, so a port that cannot be used leaves nothing behind -
 * no database file created in a directory the operator did not mean. Storage is opened next, and until
 * it is ready every request is refused as `storage_busy`, which tells a client to try again. On release
 * the listener drains first and storage closes last, after every in-flight operation has finished. No
 * signal handler is registered here; the process entry point owns that.
 */

export interface RunningServer {
  readonly host: string;
  /** The port actually bound. With `port: 0` this is the one the operating system chose. */
  readonly port: number;
  readonly databasePath: string;
}

/**
 * Why a server did not start, by stage, with the system's error code where there is one. Wording is
 * the caller's: the CLI knows which flag or file key the operator would change.
 */
export class StartupFailure extends Error {
  readonly stage: 'listen' | 'database';
  /**
   * The system error code (`EADDRINUSE`, `EACCES`, ...), or `database_in_use` or `migration_history`;
   * undefined when nothing more specific is known.
   */
  readonly code: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  constructor(
    stage: 'listen' | 'database',
    fields: {
      readonly code: string | undefined;
      readonly host: string;
      readonly port: number;
      readonly databasePath: string;
      readonly cause: unknown;
    },
  ) {
    super(`The server could not start (${stage}).`, { cause: fields.cause });
    this.name = 'StartupFailure';
    this.stage = stage;
    this.code = fields.code;
    this.host = fields.host;
    this.port = fields.port;
    this.databasePath = fields.databasePath;
  }
}

export interface ServeConfiguration {
  readonly options: BackendOptions;
  readonly credential: ApiCredential;
  /** The release this server reports to clients that verify. The caller knows it; a library does not. */
  readonly release: string;
  readonly logger?: Logger;
  /** How long shutdown waits for open connections before closing them. Tests shorten it. */
  readonly drainMs?: number;
  /** Override the migration assets beside this module. Tests and the packaged CLI use this. */
  readonly migrationsFolder?: string;
}

const routesFor = (release: string): readonly OperationRoute[] => [
  ...nodeRoutes,
  ...connectionRoutes(release),
];

const errorCode = (cause: unknown): string | undefined => {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const listen = (server: Server, host: string, port: number): Promise<AddressInfo> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** The caller keeps the enclosing scope open for as long as the server should run. */
export const serve = (
  configuration: ServeConfiguration,
): Effect.Effect<RunningServer, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => validateOptions(configuration.options),
      catch: (cause) => cause as Error,
    });
    const { credential } = configuration;
    const logger = configuration.logger ?? consoleLogger;
    const drainMs = configuration.drainMs ?? 10_000;
    const { host, port } = options.server;
    const { databasePath } = options.database;

    // Storage gets its own scope, forked before the listener's release is registered. Finalizers run
    // in reverse, so the listener drains first and storage closes after it, even though storage is
    // opened after the port is bound.
    const storageScope = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);

    let admission: 'starting' | 'open' | 'stopping' = 'starting';
    let runtime: Runtime.Runtime<Db> | undefined;
    const inFlight = new Set<Promise<unknown>>();

    const app = buildApp({
      routes: routesFor(configuration.release),
      credential,
      logger,
      admission: () => admission,
      runOperation: (effect) => {
        // Admission is checked first, so an operation never runs before storage exists.
        if (runtime === undefined) throw new Error('storage is not open');
        return Runtime.runPromiseExit(runtime)(effect);
      },
      track: (work) => {
        inFlight.add(work);
        return work.finally(() => inFlight.delete(work));
      },
    });

    const server = createServer(app);
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.timeout = 60_000;

    let started = false;
    const address = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => listen(server, host, port),
        catch: (cause) =>
          new StartupFailure('listen', { code: errorCode(cause), host, port, databasePath, cause }),
      }),
      () =>
        Effect.promise(async () => {
          admission = 'stopping';
          if (started) logger.log('info', 'server.stopping', { requests: inFlight.size });

          // `close` also closes idle keep-alive connections; busy ones get `drainMs` to finish.
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          await Promise.race([closed, sleep(drainMs)]);
          server.closeAllConnections();
          await closed;

          // Storage is released only once every running operation has finished.
          await Promise.allSettled([...inFlight]);
          if (started) logger.log('info', 'server.stopped', {});
        }),
    );

    runtime = yield* Layer.toRuntime(
      databaseLayer({
        databasePath,
        ...(configuration.migrationsFolder === undefined
          ? {}
          : { migrationsFolder: configuration.migrationsFolder }),
      }),
    ).pipe(
      Scope.extend(storageScope),
      Effect.mapError(
        (cause) =>
          new StartupFailure('database', {
            code:
              cause instanceof DatabaseUnavailableError
                ? 'database_in_use'
                : cause instanceof MigrationHistoryError
                  ? 'migration_history'
                  : errorCode(cause),
            host: address.address,
            port: address.port,
            databasePath,
            cause,
          }),
      ),
    );

    admission = 'open';
    started = true;
    logger.log('info', 'server.listening', {
      host: address.address,
      port: address.port,
      databasePath,
      release: configuration.release,
    });

    return { host: address.address, port: address.port, databasePath };
  });
