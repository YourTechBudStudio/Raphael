import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';

/** Resolved from this module so an installed backend finds the assets published beside `dist/`. */
export const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export const MIGRATIONS_TABLE = '__drizzle_migrations';

export class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationHistoryError';
  }
}

/**
 * The file holds another application's database: it has tables, views, indexes or triggers of its
 * own and no Raphael migration history. Migrating it would write Raphael's schema into someone else's
 * data, so it is refused before anything is written.
 */
export class ForeignDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForeignDatabaseError';
  }
}

/**
 * Refuse a database that already holds something and has no migration history. An empty file, as a
 * new database is, holds nothing; SQLite's own `sqlite_` objects do not count. Only reads.
 */
export const assertRaphaelOrEmpty = (db: Database.Database): void => {
  const objects = db
    .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .all() as { name: string }[];
  if (objects.length === 0 || objects.some((object) => object.name === MIGRATIONS_TABLE)) return;
  throw new ForeignDatabaseError(
    `the database at "${db.name}" holds data but no Raphael migration history, so it is not a Raphael database.`,
  );
};

/**
 * A migration's SQL failed against this database: its schema is not the one its migration history
 * says, as after a partial restore or a hand edit. The transaction rolled back, so nothing changed.
 */
export class MigrationFailedError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationFailedError';
  }
}

/** Whether SQLite itself refused a statement, somewhere along an error's cause chain. */
const sqliteRefused = (error: unknown): boolean => {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return true;
    current = current.cause;
  }
  return false;
};

const bundledTimestamps = (folder: string): ReadonlySet<number> => {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number }[];
  };
  return new Set(journal.entries.map((entry) => entry.when));
};

/**
 * Applies pending migrations. Drizzle's migrator would happily run against a database migrated by a
 * newer or different build, so any applied migration this build does not ship is refused first.
 */
export const migrateToLatest = (db: Database.Database, folder = migrationsFolder): void => {
  const hasHistory =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(MIGRATIONS_TABLE) !== undefined;
  if (hasHistory) {
    const known = bundledTimestamps(folder);
    const applied = db.prepare(`SELECT created_at AS "when" FROM ${MIGRATIONS_TABLE}`).all() as {
      when: unknown;
    }[];
    const unknown = applied.find((row) => !known.has(Number(row.when)));
    if (unknown !== undefined) {
      throw new MigrationHistoryError(
        `the database at "${db.name}" has migration ${String(unknown.when)}, which this backend does not ship. ` +
          `It was migrated by a newer or different Raphael build. Upgrade the backend, or point the database path at a new file.`,
      );
    }
  }
  try {
    drizzleMigrate(drizzle(db), { migrationsFolder: folder });
  } catch (error) {
    // Only a statement SQLite refused: a missing or unreadable migration asset is the installation's.
    if (!sqliteRefused(error)) throw error;
    const reason =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    throw new MigrationFailedError(
      `the database at "${db.name}" could not be migrated${reason === '' ? '' : `: ${reason}`}`,
      { cause: error },
    );
  }
};
