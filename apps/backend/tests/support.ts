import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Clock, Effect, Either } from 'effect';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/infrastructure/database/connection.ts';
import { Db } from '../src/infrastructure/database/layer.ts';
import { migrateToLatest } from '../src/infrastructure/database/migrate.ts';

/** The canonical empty body, as the seed migration writes it. */
export const EMPTY_BODY = '{"type":"doc","content":[{"type":"paragraph"}]}';

export type TempDatabase = {
  readonly dir: string;
  readonly file: string;
  readonly cleanup: () => void;
};

/** A real on-disk database in a throwaway directory. Nothing here uses an in-memory database: the
 * behavior under test - file modes, WAL sidecars, exclusive ownership - does not exist in memory. */
export const tempDatabase = (tag: string): TempDatabase => {
  const dir = mkdtempSync(join(tmpdir(), `raphael-${tag}-`));
  return {
    dir,
    file: join(dir, 'raphael.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Open, take ownership, and migrate. Returns the connection so tests can release it explicitly. */
export const openMigrated = (file: string): DatabaseConnection => {
  const connection = openDatabase({ databasePath: file });
  try {
    migrateToLatest(connection.db);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
};

/** Run a body against a fresh migrated database, always releasing ownership and removing the files. */
export const withMigrated = <T>(tag: string, body: (connection: DatabaseConnection) => T): T => {
  const temp = tempDatabase(tag);
  let connection: DatabaseConnection | undefined;
  try {
    connection = openMigrated(temp.file);
    return body(connection);
  } finally {
    connection?.close();
    temp.cleanup();
  }
};

/**
 * Typed query helpers. better-sqlite3 returns `unknown` rows, and the shape a test expects is part of
 * what the test asserts, so each call names it once here instead of casting inline.
 */
export const one = <T>(
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): T => db.prepare(sql).get(...params) as T;

export const many = <T>(
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): T[] => db.prepare(sql).all(...params) as T[];

export const count = (
  db: import('better-sqlite3').Database,
  sql: string,
  ...params: unknown[]
): number => one<{ c: number }>(db, sql, ...params).c;

/** Assert that a statement is rejected, and that it is rejected for the expected reason. */
export const rejects = (run: () => unknown, pattern: RegExp): string => {
  try {
    run();
  } catch (error) {
    const message = (error as Error).message;
    if (!pattern.test(message)) {
      throw new Error(
        `rejected, but not for the expected reason.\n  expected: ${pattern}\n  actual:   ${message}`,
        {
          cause: error,
        },
      );
    }
    return message;
  }
  throw new Error(`expected rejection matching ${pattern}, but the statement was accepted.`);
};

/** Insert a node directly, bypassing core validation. Test setup only. */
export const insertNode = (
  db: import('better-sqlite3').Database,
  values: {
    type: string;
    parentId?: number | null;
    parentType?: string | null;
    slug: string;
    title?: string;
    body?: string;
    id?: number;
    revision?: number;
    createdAt?: number;
    updatedAt?: number;
  },
): void => {
  const columns = [
    'type',
    'parent_id',
    'parent_type',
    'slug',
    'title',
    'body',
    'revision',
    'created_at',
    'updated_at',
  ];
  const params: unknown[] = [
    values.type,
    values.parentId ?? null,
    values.parentType ?? null,
    values.slug,
    values.title ?? 'Title',
    values.body ?? EMPTY_BODY,
    values.revision ?? 1,
    values.createdAt ?? 1_700_000_000_000,
    values.updatedAt ?? 1_700_000_000_000,
  ];
  if (values.id !== undefined) {
    columns.unshift('id');
    params.unshift(values.id);
  }
  db.prepare(
    `INSERT INTO nodes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...params);
};

/**
 * A clock the test controls.
 *
 * `next` is called for every sample, so a test can advance time between the preliminary replay lookup
 * and the authoritative one inside the transaction - and can also use the sample as a deliberate seam,
 * which is how the request-detachment tests reach the one instant between fingerprinting and storage.
 */
export const controlledClock = (next: () => number): Clock.Clock => ({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  currentTimeMillis: Effect.sync(next),
  currentTimeNanos: Effect.sync(() => BigInt(next()) * 1_000_000n),
  unsafeCurrentTimeMillis: next,
  unsafeCurrentTimeNanos: () => BigInt(next()) * 1_000_000n,
  sleep: () => Effect.void,
});

/** A clock frozen at one instant. */
export const clockAt = (millis: number): Clock.Clock => controlledClock(() => millis);

/**
 * Runs a node operation against a real connection, returning the failure rather than throwing it.
 *
 * Operations declare only `Db`, so the clock comes from Effect's default services and a test replaces it
 * with `withClock` rather than building a layer. Nothing here is asynchronous: the operations are
 * synchronous all the way down, and `runSync` is what proves it.
 */
export const runNodes = <A, E>(
  connection: DatabaseConnection,
  effect: Effect.Effect<A, E, Db>,
  clock: Clock.Clock = clockAt(1_700_000_000_000),
): Either.Either<A, E> =>
  Effect.runSync(
    Effect.either(
      Effect.provideService(Effect.withClock(effect, clock), Db, {
        db: connection.db,
        databasePath: connection.databasePath,
      }),
    ),
  );

/** The successful value, or a failed assertion naming the error that arrived instead. */
export const expectRight = <A, E>(result: Either.Either<A, E>): A => {
  if (Either.isLeft(result)) {
    throw new Error(`expected success, got ${JSON.stringify(publicOrTag(result.left))}`);
  }
  return result.right;
};

/** The failure, or a failed assertion saying the operation unexpectedly succeeded. */
export const expectLeft = <A, E>(result: Either.Either<A, E>): E => {
  if (Either.isRight(result)) {
    throw new Error('expected a failure, but the operation succeeded');
  }
  return result.left;
};

const publicOrTag = (error: unknown): unknown => {
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === 'string' ? { _tag: tag, ...(error as object) } : error;
};
