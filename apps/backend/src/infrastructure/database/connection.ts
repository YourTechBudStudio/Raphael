import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  prepareDataDirectory,
  prepareDatabaseFile,
  supportsPosixModes,
  verifySidecars,
} from './location.ts';

/**
 * Connection acquisition: pragmas, exclusive ownership, and release.
 *
 * One backend process owns one database for the entire lifetime of the connection. Ownership is taken
 * through SQLite's own `locking_mode = EXCLUSIVE`, which is enforced against any SQLite client rather
 * than by convention, is released by the kernel if the process dies, and needs no stale-lock recovery.
 * The accepted operational cost: while the server runs, external read-only SQL inspection of the
 * database is not possible - inspection requires stopping it.
 *
 * The statement order below is not cosmetic. `busy_timeout` is set before anything that can take a
 * lock, because `journal_mode = WAL` can itself need one. `locking_mode` is set before the first WAL
 * access, which is what lets SQLite elide the `-shm` wal-index; an absent `-shm` is therefore a
 * correct outcome here, not a missing file.
 */

export type DatabaseOptions = {
  /** Absolute or relative path to the database file. Resolution is the caller's decision. */
  readonly databasePath: string;
  /** Milliseconds to wait for ownership at startup. Short, so a busy database reports quickly. */
  readonly acquisitionTimeoutMs?: number;
  /** Milliseconds to wait for a lock during ordinary operation. */
  readonly busyTimeoutMs?: number;
  /** Pages before SQLite checkpoints the write-ahead log automatically. */
  readonly walAutocheckpointPages?: number;
};

/**
 * Rows examined per index by `PRAGMA optimize`. SQLite's documented recommendation is a few hundred;
 * this bounds the release path's work so shutdown cannot stall on a large database.
 */
const ANALYSIS_LIMIT = 400;

const DEFAULTS = {
  acquisitionTimeoutMs: 250,
  busyTimeoutMs: 5000,
  walAutocheckpointPages: 1000,
} as const;

export class DatabaseUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
    this.reason = reason;
  }
}

export type DatabaseConnection = {
  readonly db: Database.Database;
  readonly databasePath: string;
  /** Release ownership. Safe to call more than once. */
  readonly close: () => void;
};

/** SQLite result codes that mean another holder has the database, rather than something being wrong
 * with it. Anything else is a genuine open failure and must not be disguised as contention. */
const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_PROTOCOL', 'SQLITE_BUSY_SNAPSHOT']);

/** Run the ownership-taking statements, translating contention into an actionable failure. */
const acquiring = (databasePath: string, run: () => void): void => {
  try {
    run();
  } catch (cause) {
    const code = (cause as { code?: string }).code ?? '';
    if (BUSY_CODES.has(code) || /database is locked/i.test((cause as Error).message)) {
      throw new DatabaseUnavailableError(
        'already_in_use',
        `the database at "${databasePath}" is already in use by another Raphael process. ` +
          `One backend process owns a database for as long as it runs; stop the other one first.`,
        { cause },
      );
    }
    throw cause;
  }
};

const readPragma = (db: Database.Database, pragma: string): unknown => {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  return Object.values(row)[0];
};

/**
 * Open the database and take exclusive ownership of it.
 *
 * On any failure after the handle exists, the handle is closed before the error propagates, so a
 * failed startup never leaves the database owned.
 */
export const openDatabase = (options: DatabaseOptions): DatabaseConnection => {
  if (!supportsPosixModes()) {
    throw new DatabaseUnavailableError(
      'unsupported_platform',
      `Raphael's local backend storage is supported on macOS and Linux only. This platform (${process.platform}) ` +
        `cannot establish the file protection and exclusive ownership the database requires, and Raphael will not ` +
        `report storage as protected when it is not. Mobile, web, and remote CLI operations are unaffected.`,
    );
  }

  const databasePath = resolve(options.databasePath);
  const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? DEFAULTS.acquisitionTimeoutMs;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULTS.busyTimeoutMs;
  const walAutocheckpointPages = options.walAutocheckpointPages ?? DEFAULTS.walAutocheckpointPages;

  // Filesystem verification happens before SQLite opens anything, so the database exists at 0600 and
  // SQLite derives its sidecar modes from it.
  prepareDataDirectory(dirname(databasePath));
  prepareDatabaseFile(databasePath);

  let db: Database.Database;
  try {
    db = new Database(databasePath);
  } catch (cause) {
    throw new DatabaseUnavailableError(
      'open_failed',
      `cannot open the database at "${databasePath}".`,
      { cause },
    );
  }

  try {
    // Ownership contention can surface at any of these statements, not only at the explicit
    // acquisition below: `journal_mode = WAL` takes a lock of its own. They are therefore run under
    // one classifier, so a busy database always reports as "already in use" rather than leaking a
    // bare "database is locked" from whichever statement happened to reach the lock first.
    acquiring(databasePath, () => {
      db.pragma(`busy_timeout = ${acquisitionTimeoutMs}`);
      db.pragma('locking_mode = EXCLUSIVE');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      db.pragma(`wal_autocheckpoint = ${walAutocheckpointPages}`);
      // Bounds the release-path `PRAGMA optimize`. Without it, optimize may run a full ANALYZE whose
      // cost grows with table size, and exclusive ownership is held until it finishes - so an
      // unexpectedly expensive optimize would delay shutdown and lock release. This caps the rows
      // examined per index, which is what makes the work bounded by configuration rather than by how
      // much the owner happens to have stored. Set here so it is verified at startup rather than
      // discovered at close.
      db.pragma(`analysis_limit = ${ANALYSIS_LIMIT}`);

      // Setting `locking_mode` configures intent; SQLite takes the lock on first access and then
      // keeps it. This write transaction is what actually acquires ownership. It writes no
      // application data and no schema: no Raphael migration or application mutation runs before the
      // compatibility guard.
      db.exec('BEGIN IMMEDIATE');
      db.exec('COMMIT');
    });

    verifyEffectivePragmas(db, databasePath, walAutocheckpointPages);

    // Sidecars appear once WAL is engaged. `lstat` only - no second open against a database SQLite
    // now owns.
    verifySidecars(databasePath);

    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }

  let closed = false;
  return {
    db,
    databasePath,
    close: () => {
      if (closed) return;
      closed = true;
      closeQuietly(db);
    },
  };
};

/**
 * Read back what SQLite actually applied. A pragma that silently did not take effect - WAL refused on
 * an unusual filesystem, say - would otherwise leave the process running with weaker durability than
 * it reports.
 */
const verifyEffectivePragmas = (
  db: Database.Database,
  databasePath: string,
  walAutocheckpointPages: number,
): void => {
  const expectations: ReadonlyArray<readonly [string, string, unknown]> = [
    ['journal_mode', 'journal_mode', 'wal'],
    ['locking_mode', 'locking_mode', 'exclusive'],
    ['synchronous', 'synchronous (2 = FULL)', 2],
    ['foreign_keys', 'foreign_keys', 1],
    ['wal_autocheckpoint', 'wal_autocheckpoint', walAutocheckpointPages],
    // Verified rather than assumed: if this pragma were silently ignored, the bounded-shutdown
    // guarantee below would be false while still being claimed.
    ['analysis_limit', 'analysis_limit', ANALYSIS_LIMIT],
  ];
  for (const [pragma, label, expected] of expectations) {
    const actual = readPragma(db, pragma);
    if (actual !== expected) {
      throw new DatabaseUnavailableError(
        'pragma_not_effective',
        `the database at "${databasePath}" did not apply ${label}: expected ${String(expected)}, got ${String(actual)}. ` +
          `Raphael will not run with weaker durability or integrity settings than it requires.`,
      );
    }
  }
};

/**
 * Bounded maintenance on the way out, then close.
 *
 * The work is bounded by `analysis_limit`, verified at startup: optimize examines at most that many
 * rows per index, so its cost follows the schema rather than how much the owner has stored. The limit
 * is reasserted here so a caller that changed it on the connection cannot silently unbound the
 * release path. This is a bound on work, not interruptibility - the call is synchronous SQLite work
 * that no Effect or Promise timeout can cancel, which is precisely why the bound has to be
 * configured in advance rather than enforced with a deadline.
 *
 * `PRAGMA optimize` is advisory: if it fails, the connection must still close and release ownership,
 * so optional-maintenance failure is kept separate from close failure.
 */
const closeQuietly = (db: Database.Database): void => {
  try {
    db.pragma(`analysis_limit = ${ANALYSIS_LIMIT}`);
    db.pragma('optimize');
  } catch {
    // Optional maintenance. Never prevents release of ownership.
  }
  db.close();
};
