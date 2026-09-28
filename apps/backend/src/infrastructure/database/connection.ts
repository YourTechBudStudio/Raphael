import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

/**
 * One backend process owns one database for as long as it runs, through SQLite's own
 * `locking_mode = EXCLUSIVE`: any other SQLite client is refused, and the kernel releases the lock if
 * the process dies.
 */

export type DatabaseOptions = {
  readonly databasePath: string;
  /** Milliseconds to wait for ownership at startup. Short, so a second server fails promptly. */
  readonly acquisitionTimeoutMs?: number;
};

/** Bounds the `PRAGMA optimize` run on close, so shutdown cannot stall on a large database. */
const ANALYSIS_LIMIT = 400;

export class DatabaseUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
  }
}

export type DatabaseConnection = {
  readonly db: Database.Database;
  readonly databasePath: string;
  /** Release ownership. Safe to call more than once. */
  readonly close: () => void;
};

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_PROTOCOL', 'SQLITE_BUSY_SNAPSHOT']);

export const openDatabase = (options: DatabaseOptions): DatabaseConnection => {
  const databasePath = resolve(options.databasePath);

  // The file exists at 0600 before SQLite opens it, because SQLite gives the WAL the database's mode.
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  closeSync(openSync(databasePath, 'a', 0o600));

  const db = new Database(databasePath);
  try {
    db.pragma(`busy_timeout = ${options.acquisitionTimeoutMs ?? 250}`);
    // Before the first WAL access, so SQLite keeps the wal-index in memory rather than in `-shm`.
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma(`analysis_limit = ${ANALYSIS_LIMIT}`);
    // Setting the locking mode takes nothing; the first write does.
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (cause) {
    db.close();
    const code = (cause as { code?: string }).code ?? '';
    if (BUSY_CODES.has(code)) {
      throw new DatabaseUnavailableError(
        `the database at "${databasePath}" is already in use by another Raphael process. Stop the other one first.`,
        { cause },
      );
    }
    throw cause;
  }

  let closed = false;
  return {
    db,
    databasePath,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.pragma('optimize');
      } catch {
        // Optional maintenance; never blocks releasing ownership.
      }
      db.close();
    },
  };
};
