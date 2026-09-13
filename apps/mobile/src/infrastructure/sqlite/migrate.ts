/**
 * Versioned schema, applied transactionally, refusing what it does not understand.
 *
 * `PRAGMA user_version` is the version, which means the version travels inside the database file
 * rather than beside it: a database restored, copied, or left behind by a previous install carries
 * its own account of what it is. A separate table would be one more thing that can disagree with the
 * schema it describes.
 *
 * Three rules the rest of the app depends on:
 *
 * **A newer database is refused, not downgraded.** A build older than the file it opens cannot know
 * what the newer schema means, and a downgrade would be a guess about someone's unsent work. The
 * caller is told, and tells the person; nothing is deleted, recreated, or repaired.
 *
 * **Each step is one transaction.** A migration that fails halfway leaves the database exactly as it
 * was, at its previous version, rather than at a shape no version describes.
 *
 * **A failure is reported, not swallowed.** There is no fallback path that quietly starts over with
 * an empty database, because the data this protects is work that was never sent anywhere else.
 *
 * Generic on purpose: no capability's schema appears here. One capability supplies its steps at
 * composition, and this runs them.
 */

import type { SqlConnection } from './port.ts';

export interface Migration {
  /** The version this step produces. Steps run in ascending order and must be contiguous from 1. */
  readonly version: number;
  /** Applied in order, inside one transaction with the version bump. */
  readonly statements: readonly string[];
}

export type MigrationOutcome =
  | { readonly kind: 'ready'; readonly version: number }
  /** The file was written by a newer build. Nothing was changed. */
  | { readonly kind: 'unsupported_version'; readonly found: number; readonly supported: number }
  /** A step failed and was rolled back. The database is still at `version`. */
  | { readonly kind: 'failed'; readonly version: number; readonly message: string };

const readVersion = async (db: SqlConnection): Promise<number> => {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version;

  return typeof version === 'number' ? version : 0;
};

/**
 * `PRAGMA user_version = ?` does not accept a bound parameter, so the value is interpolated - and
 * that is only safe because it can never be anything but one of our own declared step versions. The
 * assertion is what keeps that true if someone later builds a step list from something else.
 */
const writeVersion = async (tx: { run: SqlConnection['run'] }, version: number): Promise<void> => {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`a schema version must be a non-negative integer, not ${String(version)}`);
  }

  await tx.run(`PRAGMA user_version = ${String(version)}`);
};

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'the migration failed';

/**
 * Bring `db` up to the highest declared version, or explain why it is not there.
 *
 * Safe to repeat. A version already applied is skipped, so an initialization interrupted between two
 * steps resumes at the step it did not finish rather than replaying the ones it did.
 */
export const migrate = async (
  db: SqlConnection,
  migrations: readonly Migration[],
): Promise<MigrationOutcome> => {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const supported = ordered.at(-1)?.version ?? 0;

  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error('migration versions must be contiguous and start at 1');
    }
  });

  let version = await readVersion(db);

  if (version > supported) {
    return { kind: 'unsupported_version', found: version, supported };
  }

  for (const migration of ordered) {
    if (migration.version <= version) continue;

    try {
      await db.transaction(async (tx) => {
        for (const statement of migration.statements) {
          await tx.run(statement);
        }
        await writeVersion(tx, migration.version);
      });
    } catch (cause) {
      return { kind: 'failed', version, message: describe(cause) };
    }

    version = migration.version;
  }

  return { kind: 'ready', version };
};
