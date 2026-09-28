import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Clock } from 'effect';

import { InternalFailure } from './errors.ts';
import { MAX_SAFE_DB_INTEGER } from './schema.ts';
import { raise } from './storage-failures.ts';

/**
 * Every database interaction runs inside one of the two transaction helpers, and their bodies are
 * fully synchronous, so nothing else can run between their statements.
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

/** A consistent multi-statement read; deferred, so it takes no write lock. */
export const readTransaction = <T>(db: Database.Database, body: () => T): T =>
  db.transaction(body).deferred();

/** Immediate, so the write lock is taken when the transaction opens. */
export const writeTransaction = <T>(db: Database.Database, body: () => T): T =>
  db.transaction(body).immediate();

/** A timestamp about to be stored; an unusable reading is an internal failure, never clamped. */
export const sampleNow = (clock: Clock.Clock, operation: string): number => {
  const now = clock.unsafeCurrentTimeMillis();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_SAFE_DB_INTEGER) {
    return raise(
      new InternalFailure({ operation, detail: 'the clock reported an unusable current time' }),
    );
  }
  return now;
};

/** A generated row id, refused outside the safe integer range rather than rounded. */
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
