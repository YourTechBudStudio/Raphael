import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';

import { inspectMigrationHistory, readBundledMigrations, type MigrationState } from './guard.ts';

/**
 * Migration assets ship with the package. Resolving them from this module's own URL rather than the
 * process working directory is what lets a compiled, installed backend find them: `dist/` sits one
 * level below the package root, and `drizzle/` is published alongside it.
 */
export const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/**
 * Bring the database to the bundled schema version.
 *
 * Order: verify compatibility, apply whatever is pending through Drizzle's own migrator, then verify
 * the result. Drizzle applies every pending migration inside one transaction, so a failure part-way
 * leaves the database exactly as it was - there is no partially-migrated state to recover from.
 *
 * Migrations are only ever applied from committed assets. Nothing here generates SQL at runtime and
 * `push` is never used.
 */
export const migrateToLatest = (
  db: Database.Database,
  folder = migrationsFolder,
): MigrationState => {
  const bundled = readBundledMigrations(folder);

  const before = inspectMigrationHistory(db, bundled);
  if (before.state === 'current') return before;

  drizzleMigrate(drizzle(db), { migrationsFolder: folder });

  const after = inspectMigrationHistory(db, bundled);
  if (after.state !== 'current') {
    // Not a concurrency check - ownership is held throughout. This catches the migrator applying
    // something other than what the journal described.
    throw new Error(
      `migration did not reach the bundled schema version: expected every migration applied, got "${after.state}".`,
    );
  }
  return after;
};
