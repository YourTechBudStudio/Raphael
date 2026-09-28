import type Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';

import { openDatabase, type DatabaseOptions } from './connection.ts';
import { migrateToLatest } from './migrate.ts';

export type DatabaseService = {
  readonly db: Database.Database;
  readonly databasePath: string;
};

export class Db extends Context.Tag('@raphael/backend/Database')<Db, DatabaseService>() {}

export type DatabaseLayerOptions = DatabaseOptions & {
  /** Override the bundled migration assets. Tests use this; the server does not. */
  readonly migrationsFolder?: string;
};

/** Opens, takes ownership and migrates; a failed migration still releases ownership. */
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
