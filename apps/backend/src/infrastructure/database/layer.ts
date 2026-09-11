import type Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';

import { openDatabase, type DatabaseOptions } from './connection.ts';
import { migrateToLatest } from './migrate.ts';

/**
 * The database as a scoped resource.
 *
 * There is one genuine lifetime obligation here - exclusive ownership of the database file, held for
 * as long as the connection lives - so it is expressed as a scoped Layer: acquisition and release are
 * paired, and release runs on every exit path including a failure later in startup. There are no
 * services for individual pragmas or tables; the surface is deliberately small.
 *
 * No clock lives here. Operations that need one take it as their own dependency (phase 04); storage
 * has no reason to invent a second one.
 */

export type DatabaseService = {
  /** The owned connection. Business operations hold this; nothing else opens the file. */
  readonly db: Database.Database;
  readonly databasePath: string;
};

export class Db extends Context.Tag('@raphael/backend/Database')<Db, DatabaseService>() {}

export type DatabaseLayerOptions = DatabaseOptions & {
  /** Override the bundled migration assets. Tests use this; the server does not. */
  readonly migrationsFolder?: string;
};

/**
 * Open the database, take ownership, bring it to the bundled schema version, and release everything
 * on scope close.
 *
 * `acquireRelease` is what guarantees the failure path: if migration throws, the connection is still
 * closed and ownership released, so a failed startup never leaves the database locked.
 */
export const layer = (options: DatabaseLayerOptions): Layer.Layer<Db, Error> =>
  Layer.scoped(
    Db,
    Effect.acquireRelease(
      Effect.try({
        try: () => openDatabase(options),
        catch: (error) => error as Error,
      }),
      (connection) => Effect.sync(() => connection.close()),
    ).pipe(
      Effect.tap((connection) =>
        Effect.try({
          try: () => migrateToLatest(connection.db, options.migrationsFolder),
          catch: (error) => error as Error,
        }),
      ),
      Effect.map((connection) => ({ db: connection.db, databasePath: connection.databasePath })),
    ),
  );
