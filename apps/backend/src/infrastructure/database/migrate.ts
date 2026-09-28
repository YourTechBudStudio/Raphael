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
  drizzleMigrate(drizzle(db), { migrationsFolder: folder });
};
