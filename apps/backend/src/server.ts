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
import { bindConnections } from './infrastructure/http/connections.ts';
import { DEFAULT_DEADLINES, type Deadlines } from './infrastructure/http/deadlines.ts';
import { consoleLogger, type Logger } from './infrastructure/http/log.ts';
import type { OperationRoute } from './infrastructure/http/operation.ts';
import { connectionRoutes } from './modules/connection/index.ts';
import { nodeRoutes } from './modules/nodes/routes.ts';

/**
 * Composition: configuration in, a listening server out, everything released on the way back.
 *
 * The whole thing is one scoped resource. Acquisition is ordered - validate, open and migrate the
 * database, build the runtime, register routes, listen - and any failure along the
 * way unwinds what was already acquired, so a server that fails to start never leaves the database
 * owned.
 *
 * Release is the same order backwards, and it is written out explicitly rather than left to the scope,
 * because the sequence is the contract:
 *
 *   stop admitting -> drain in-flight requests -> close remaining
 *   connections -> release the runtime and the database
 *
 * The drain deadline bounds how long we wait for the *network*. It is not permission to close storage
 * underneath unfinished work: the database is released only after every operation fiber has actually
 * finished, however long that takes. Those two are different waits and conflating them would mean
 * closing a connection out from under a committing transaction.
 *
 * The deadline is cooperative in a second sense worth stating plainly: it cannot fire while
 * synchronous content conversion or a SQLite call holds this thread, because nothing fires while the
 * event loop is not running.
 *
 * No signal handler is registered here and `process.exit` is never called. This is a library; the
 * process entry point owns SIGINT, SIGTERM, and the decision to escalate.
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
  /** Shorter durations for tests. Not reachable from the YAML surface. */
  readonly deadlines?: Partial<Deadlines>;
  /** Override the bundled migration assets. Tests use this; a server does not. */
  readonly migrationsFolder?: string;
}

/** Every route this server publishes. Each capability owns its own registrations. */
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

/** Stop accepting. Resolves once every existing connection has ended. */
const stopAccepting = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

/**
 * One turn of the event loop.
 *
 * Used once during shutdown, and it earns its place. A request whose bytes are already in the kernel
 * buffer has not been parsed yet, so `closeIdleConnections` cannot tell it apart from a keep-alive
 * connection sitting idle and would destroy it - the caller would see a reset and have to treat a
 * creation as uncertain, for no reason other than our own ordering. One turn is enough for Node to
 * parse what has already arrived and for that connection to stop counting as idle.
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Start the server, and return the address it actually bound.
 *
 * The caller must keep the enclosing scope open for as long as the server should run. `Effect.scoped`
 * around this call alone would acquire the listener and release it the moment the effect returned;
 * the process entry point holds the scope until it decides to shut down.
 */
export const serve = (
  configuration: ServeConfiguration,
): Effect.Effect<RunningServer, Error, Scope.Scope> =>
  Effect.gen(function* () {
    // Re-checked here rather than trusted, and what comes back is a *snapshot*. `BackendOptions` is an
    // ordinary structure, so a caller can construct one this loader never saw, and an out-of-range
    // value would otherwise reach a timer or a delete statement. Checking it would not be enough on its
    // own: startup is asynchronous and the batch size is not read until after the listener exists, so a
    // caller could mutate the object in between. Every supplied value is read once, and the server runs
    // from `options` below - never from `configuration.options` again. The credential enforces its own
    // policy in its only constructor.
    const options = yield* Effect.try({
      try: () => validateOptions(configuration.options),
      catch: (cause) => cause as Error,
    });
    const { credential } = configuration;
    const logger = configuration.logger ?? consoleLogger;
    const deadlines: Deadlines = { ...DEFAULT_DEADLINES, ...configuration.deadlines };

    // The database is acquired first, inside this scope, so it is the last thing released. Opening it
    // also runs the migrations: readiness means the schema is current, and a migration failure is a
    // startup failure rather than something a request discovers.
    const runtime = yield* Layer.toRuntime(
      databaseLayer({
        databasePath: options.database.databasePath,
        busyTimeoutMs: options.database.busyTimeoutMs,
        ...(configuration.migrationsFolder === undefined
          ? {}
          : { migrationsFolder: configuration.migrationsFolder }),
      }),
    );

    let admitting = true;
    // In-flight operation work, tracked as promises. Shutdown waits on these before the database is
    // released - not on the sockets, which are a separate and bounded wait.
    const inFlight = new Set<Promise<unknown>>();

    const app = buildApp({
      routes: allRoutes,
      credential,
      logger,
      deadlines,
      admitting: () => admitting,
      runOperation: (effect) => Runtime.runPromiseExit(runtime)(effect),
      track: (work) => {
        inFlight.add(work);
        return work.finally(() => inFlight.delete(work));
      },
    });

    const server = createServer({ connectionsCheckingInterval: deadlines.checkIntervalMs }, app);
    // Node's own properties, plus the explicit per-connection timers that make the receive deadlines
    // actually hold. See `connections.ts` for which client behaviors each one does and does not bound.
    server.headersTimeout = deadlines.headersMs;
    server.requestTimeout = deadlines.requestMs;
    server.keepAliveTimeout = deadlines.keepAliveMs;
    server.timeout = deadlines.socketIdleMs;
    const connections = bindConnections(server, deadlines);

    const started = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const address = await listen(server, options.server.host, options.server.port);
          return { address };
        },
        catch: (cause) => cause as Error,
      }),
      () =>
        Effect.promise(async () => {
          admitting = false;
          logger.log('info', 'server.stopping', {
            // Counts only: how much there is to wait for. Never an address, a route, or a caller.
            connections: connections.speaking(),
            requests: inFlight.size,
          });

          const closed = stopAccepting(server);
          await tick();
          // Connections holding nothing are closed now, so shutdown does not wait out their
          // keep-alive expiry. A connection whose bytes have arrived - parsed or not - is left to the
          // drain instead of being reset, which is the difference between an answered request and an
          // outcome the caller has to go and check.
          connections.closeQuiet();
          await Promise.race([closed, sleep(deadlines.drainMs)]);
          // Whatever is left after the cooperative deadline is a connection that will not end on its
          // own. Closing it is a network decision and says nothing about work already in progress -
          // the wait below is what protects that.
          server.closeAllConnections();
          await closed;

          // Only now is it safe to release the database: every operation that was running has
          // finished. This wait is deliberately unbounded - the drain deadline governs sockets, and
          // closing storage beneath a committing transaction is not an outcome a deadline may buy.
          await Promise.allSettled([...inFlight]);
          logger.log('info', 'server.stopped', {});
        }),
    );

    const { address } = started;

    logger.log('info', 'server.listening', {
      host: address.address,
      port: address.port,
      databasePath: options.database.databasePath,
    });

    return { host: address.address, port: address.port };
  });
