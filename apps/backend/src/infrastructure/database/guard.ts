import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import { MAX_SAFE_DB_INTEGER } from '../../modules/nodes/schema.ts';

/**
 * Migration-history compatibility.
 *
 * The applied history must be an exact ordered prefix of the migrations bundled with this backend.
 * That rejects a database migrated by a newer build, a migration whose SQL changed after it was
 * applied, an inconsistent history, and a nonempty database that is not a Raphael database at all.
 *
 * What this is not: a schema-integrity verifier. It compares migration history, so it cannot detect
 * a hand-edited table or a manually dropped index. Do not describe it as proving the schema correct.
 *
 * Hashes are derived the way Drizzle's own migrator derives them - sha256 over the raw bytes of each
 * `.sql` file, located through the journal's `tag` - because the journal itself records no hashes.
 * Reimplementing that reading is deliberate: guessing a different digest would make every database
 * look incompatible.
 */

export const MIGRATIONS_TABLE = '__drizzle_migrations';

export type BundledMigration = {
  readonly index: number;
  readonly tag: string;
  readonly when: number;
  readonly hash: string;
};

export type MigrationState =
  | { readonly state: 'fresh' }
  | { readonly state: 'current'; readonly applied: number }
  | { readonly state: 'pending'; readonly applied: number; readonly pending: number };

export class MigrationHistoryError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'MigrationHistoryError';
    this.reason = reason;
  }
}

const fail = (reason: string, message: string): never => {
  throw new MigrationHistoryError(reason, message);
};

type JournalEntry = { idx: number; when: number; tag: string };

/** Read the bundled migrations in journal order, hashing each file as the migrator would. */
export const readBundledMigrations = (migrationsFolder: string): readonly BundledMigration[] => {
  let journalRaw: string;
  try {
    journalRaw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
  } catch (cause) {
    fail(
      'journal_unreadable',
      `cannot read the migration journal in "${migrationsFolder}". The backend's migration assets are ` +
        `missing or unreadable; this is a packaging fault, not a database problem.`,
    );
    throw cause;
  }

  const journal = JSON.parse(journalRaw) as { entries?: JournalEntry[] };
  const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx);
  if (entries.length === 0)
    fail('journal_empty', `the migration journal in "${migrationsFolder}" lists no migrations.`);

  const seenWhen = new Set<number>();
  return entries.map((entry, position) => {
    if (entry.idx !== position) {
      fail(
        'journal_inconsistent',
        `the migration journal is inconsistent: entry ${position} declares index ${entry.idx}.`,
      );
    }
    // `when` is the only ordering key the receipts carry, so duplicates would make the applied
    // sequence ambiguous rather than merely odd.
    if (seenWhen.has(entry.when)) {
      fail(
        'journal_duplicate_timestamp',
        `the migration journal contains two migrations with timestamp ${entry.when}; applied history ` +
          `could not be ordered unambiguously.`,
      );
    }
    seenWhen.add(entry.when);

    let sql: Buffer;
    try {
      sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`));
    } catch (cause) {
      fail(
        'migration_file_missing',
        `the migration file "${entry.tag}.sql" named by the journal is missing.`,
      );
      throw cause;
    }
    return {
      index: entry.idx,
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(sql.toString('utf8')).digest('hex'),
    };
  });
};

/**
 * A receipt integer is read and checked before it is trusted. better-sqlite3 converts a 64-bit value
 * into a JavaScript number, and a value above the safe range is rounded on the way out - so a bogus
 * timestamp could otherwise compare equal to a legitimate one after rounding.
 */
const safeReceiptInteger = (value: unknown, column: string): number => {
  if (typeof value === 'bigint') {
    if (value > BigInt(MAX_SAFE_DB_INTEGER) || value < 0n) {
      fail(
        'receipt_integer_unsafe',
        `the migration history contains a ${column} value outside the safely representable range.`,
      );
    }
    return Number(value);
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_DB_INTEGER
  ) {
    fail(
      'receipt_integer_unsafe',
      `the migration history contains a ${column} value that is not a safely representable integer.`,
    );
  }
  return value as number;
};

/** Columns this backend reads from the receipt table. */
const REQUIRED_RECEIPT_COLUMNS = ['hash', 'created_at'] as const;

/**
 * Read the applied receipts, treating the receipt table's *shape* as untrusted boundary data in the
 * same way its name is.
 *
 * `__drizzle_migrations` is shared across Drizzle applications and versions, so finding one says
 * nothing about its columns. Querying it blindly turns an entirely expected foreign-database
 * condition into a raw `SqliteError`, which no caller can classify or act on. Its structure is
 * therefore checked before it is read, and the read itself is wrapped, so every variant leaves this
 * function as a typed failure.
 *
 * Column *values* are not validated here - the callers below already reject a receipt whose hash is
 * unusable or whose timestamp is not a safe integer.
 */
const readReceipts = (
  db: Database.Database,
  foreignObjects: readonly string[],
): { hash: unknown; created_at: unknown }[] => {
  const receiptObject = db
    .prepare(`SELECT type FROM sqlite_master WHERE name = ?`)
    .get(MIGRATIONS_TABLE) as { type: string } | undefined;

  if (receiptObject === undefined) return [];

  if (receiptObject.type !== 'table') {
    fail(
      'receipt_malformed',
      `"${MIGRATIONS_TABLE}" exists in this database as a ${receiptObject.type}, not a table, so its ` +
        `migration history cannot be read. This database was not produced by Raphael; point the ` +
        `configured database path at a new file.`,
    );
  }

  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${MIGRATIONS_TABLE})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const missing = REQUIRED_RECEIPT_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    const detail =
      `its "${MIGRATIONS_TABLE}" table has no ${missing.join(' or ')} column, so it belongs to a ` +
      `different Drizzle application or a Drizzle version this backend cannot read`;
    if (foreignObjects.length > 0) {
      fail(
        'unrelated_database',
        `the file already contains ${foreignObjects.join(', ')} and ${detail}. Raphael will not write ` +
          `into someone else's data; point the configured database path at a new file.`,
      );
    }
    fail(
      'receipt_malformed',
      `this database cannot be adopted: ${detail}. Point the configured database path at a new file.`,
    );
  }

  try {
    return db.prepare(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE}`).all() as {
      hash: unknown;
      created_at: unknown;
    }[];
  } catch (cause) {
    fail(
      'receipt_malformed',
      `the "${MIGRATIONS_TABLE}" table in this database could not be read as a migration history, so ` +
        `ownership cannot be established. Point the configured database path at a new file.`,
    );
    throw cause;
  }
};

/**
 * Compare applied history against the bundled migrations. Runs before any pending migration is
 * applied, and again afterwards.
 *
 * The second run is not a concurrency remedy - exclusive ownership is held for the whole connection,
 * so nothing else can have touched the database in between. It is a self-consistency check on the
 * migrator: did it apply exactly what the journal described?
 */
export const inspectMigrationHistory = (
  db: Database.Database,
  bundled: readonly BundledMigration[],
): MigrationState => {
  // Ownership is established by a nonempty applied history that matches our own migrations, never by
  // the presence of the receipt table. `__drizzle_migrations` is the default name for every Drizzle
  // project, so finding one proves only that some Drizzle application has been here - and an empty
  // one proves nothing at all.
  const foreignObjects = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name <> ?
         ORDER BY name`,
      )
      .all(MIGRATIONS_TABLE) as { name: string }[]
  ).map((row) => row.name);

  const applied = readReceipts(db, foreignObjects)
    .map((row) => {
      if (typeof row.hash !== 'string' || row.hash.length === 0) {
        fail('receipt_malformed', `the migration history contains a receipt with no usable hash.`);
      }
      return { hash: row.hash as string, when: safeReceiptInteger(row.created_at, 'created_at') };
    })
    .sort((a, b) => a.when - b.when);

  // No applied history means nothing here has proven the database is ours. It may be adopted only if
  // it is genuinely empty: a receipt table alone is acceptable (some Drizzle tool created it and
  // applied nothing), but any real object belongs to someone else.
  if (applied.length === 0) {
    if (foreignObjects.length > 0) {
      fail(
        'unrelated_database',
        `the file already contains ${foreignObjects.join(', ')} but no applied Raphael migrations. ` +
          `This is not a Raphael database - a "${MIGRATIONS_TABLE}" table is the Drizzle default and belongs to ` +
          `any Drizzle application, so it does not make this database ours. Raphael will not write into someone ` +
          `else's data; point the configured database path at a new file.`,
      );
    }
    return { state: 'fresh' };
  }

  for (let i = 1; i < applied.length; i++) {
    if (applied[i]!.when === applied[i - 1]!.when) {
      fail(
        'history_ambiguous',
        `the migration history contains two receipts with timestamp ${applied[i]!.when}, so its order is ambiguous.`,
      );
    }
  }

  if (applied.length > bundled.length) {
    fail(
      'newer_database',
      `the database has ${applied.length} applied migrations but this backend bundles only ${bundled.length}. ` +
        `It was migrated by a newer Raphael build; running this one against it could corrupt data. Upgrade the backend.`,
    );
  }

  for (let i = 0; i < applied.length; i++) {
    const wanted = bundled[i]!;
    const got = applied[i]!;
    if (got.hash !== wanted.hash) {
      fail(
        'history_mismatch',
        `applied migration ${i} does not match this backend's migration "${wanted.tag}". ` +
          `The migration history diverges from the bundled assets; this database was produced by a different build.`,
      );
    }
    if (got.when !== wanted.when) {
      fail(
        'history_mismatch',
        `applied migration ${i} ("${wanted.tag}") carries timestamp ${got.when} but this backend records ${wanted.when}.`,
      );
    }
  }

  return applied.length === bundled.length
    ? { state: 'current', applied: applied.length }
    : { state: 'pending', applied: applied.length, pending: bundled.length - applied.length };
};
