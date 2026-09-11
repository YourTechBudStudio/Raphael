import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Clock } from 'effect';

import { InternalFailure } from './errors.ts';
import { MAX_SAFE_DB_INTEGER } from './schema.ts';
import { raise } from './storage-failures.ts';

/**
 * The connection-facing helpers: one query handle per database, the two transaction shapes, and the
 * clock sample.
 *
 * Every database interaction in this capability happens inside one of the two transaction helpers, and
 * the function they run is entirely synchronous. That is the whole consistency argument: a multi-
 * statement read cannot observe a write part-way through, not because today's connection happens to be
 * exclusive and single-threaded, but because there is no point between its statements at which anything
 * else could run. Nothing awaits or executes a nested Effect inside these functions.
 */

/** One Drizzle handle per connection. Rebuilding it per query would discard its statement cache. */
const handles = new WeakMap<Database.Database, BetterSQLite3Database>();

export type Orm = BetterSQLite3Database;

export const orm = (db: Database.Database): Orm => {
  const existing = handles.get(db);
  if (existing !== undefined) return existing;
  const created = drizzle(db);
  handles.set(db, created);
  return created;
};

/**
 * A consistent multi-statement read.
 *
 * Deferred is correct here: the transaction takes no write lock, and it exists to state the snapshot
 * the reads rely on rather than to exclude anyone.
 */
export const readTransaction = <T>(db: Database.Database, body: () => T): T =>
  db.transaction(body).deferred();

/**
 * A short write.
 *
 * Immediate, so the write lock is taken when the transaction opens rather than part-way through. A
 * failure inside the body rolls the whole thing back, which is what lets the node insert and its
 * replay record commit as one fact.
 */
export const writeTransaction = <T>(db: Database.Database, body: () => T): T =>
  db.transaction(body).immediate();

/**
 * Samples the clock for a value about to be stored.
 *
 * Storage constrains its timestamp columns to integral, exactly-representable values, and core is the
 * only source of those values because the columns have no SQL default. An unusable reading is
 * therefore an internal failure rather than something to clamp: a clamped timestamp would be a
 * fabricated fact about when something happened.
 */
export const sampleNow = (clock: Clock.Clock, operation: string): number => {
  const now = clock.unsafeCurrentTimeMillis();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_SAFE_DB_INTEGER) {
    return raise(
      new InternalFailure({ operation, detail: 'the clock reported an unusable current time' }),
    );
  }
  return now;
};

/**
 * Converts a generated row id, which better-sqlite3 reports as a number or a bigint depending on how
 * the connection is configured. A value outside the safe range is refused rather than converted: past
 * that point the conversion *rounds*, and a rounded id names a different row while still looking like
 * a valid one.
 */
export const safeRowId = (value: number | bigint, operation: string): number => {
  if (typeof value === 'bigint') {
    if (value <= 0n || value > BigInt(MAX_SAFE_DB_INTEGER)) {
      return raise(
        new InternalFailure({
          operation,
          detail: 'the generated row id is outside the safe range',
        }),
      );
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    return raise(
      new InternalFailure({ operation, detail: 'the generated row id is not a safe integer' }),
    );
  }
  return value;
};
