import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Effect, Layer, Runtime, type Scope } from 'effect';

import {
  validateOptions,
  type ApiCredential,
  type BackendOptions,
} from './infrastructure/config/index.ts';
import { layer as databaseLayer } from './infrastructure/database/index.ts';
import { buildApp } from './infrastructure/http/app.ts';
import { consoleLogger, type Logger } from './infrastructure/http/log.ts';
import type { OperationRoute } from './infrastructure/http/operation.ts';
import { connectionRoutes } from './modules/connection/index.ts';
import { nodeRoutes } from './modules/nodes/routes.ts';

/**
 * One scoped resource: the database is acquired first and released last, after every in-flight
 * operation has finished. No signal handler is registered here; the process entry point owns that.
 */

export interface RunningServer {
  readonly host: string;
  /** The port actually bound. With `port: 0` this is the one the operating system chose. */
  readonly port: number;
}

export interface ServeConfiguration {
  readonly options: BackendOptions;
  readonly credential: ApiCredential;
  readonly logger?: Logger;
  /** How long shutdown waits for open connections before closing them. Tests shorten it. */
  readonly drainMs?: number;
  /** Override the bundled migration assets. Tests use this; a server does not. */
  readonly migrationsFolder?: string;
}

const allRoutes: readonly OperationRoute[] = [...nodeRoutes, ...connectionRoutes];

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

    const runtime = yield* Layer.toRuntime(
      databaseLayer({
        databasePath: options.database.databasePath,
        ...(configuration.migrationsFolder === undefined
          ? {}
          : { migrationsFolder: configuration.migrationsFolder }),
      }),
    );

    let admitting = true;
    const inFlight = new Set<Promise<unknown>>();

    const app = buildApp({
      routes: allRoutes,
      credential,
      logger,
      admitting: () => admitting,
      runOperation: (effect) => Runtime.runPromiseExit(runtime)(effect),
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

    const address = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => listen(server, options.server.host, options.server.port),
        catch: (cause) => cause as Error,
      }),
      () =>
        Effect.promise(async () => {
          admitting = false;
          logger.log('info', 'server.stopping', { requests: inFlight.size });

          // `close` also closes idle keep-alive connections; busy ones get `drainMs` to finish.
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          await Promise.race([closed, sleep(drainMs)]);
          server.closeAllConnections();
          await closed;

          // Storage is released only once every running operation has finished.
          await Promise.allSettled([...inFlight]);
          logger.log('info', 'server.stopped', {});
        }),
    );

    logger.log('info', 'server.listening', {
      host: address.address,
      port: address.port,
      databasePath: options.database.databasePath,
    });

    return { host: address.address, port: address.port };
  });
