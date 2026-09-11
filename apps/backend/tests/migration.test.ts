import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import { openDatabase } from '../src/infrastructure/database/connection.ts';
import {
  MigrationHistoryError,
  inspectMigrationHistory,
  readBundledMigrations,
} from '../src/infrastructure/database/guard.ts';
import { migrateToLatest, migrationsFolder } from '../src/infrastructure/database/migrate.ts';
import {
  EMPTY_BODY,
  count,
  insertNode,
  many,
  one,
  openMigrated,
  rejects,
  tempDatabase,
  withMigrated,
} from './support.ts';

describe('migration assets', () => {
  test('resolve relative to the package, not the working directory', () => {
    // A compiled, installed backend is started from an arbitrary directory. If this resolution used
    // process.cwd() the server would find its migrations only when launched from the repository.
    assert.ok(existsSync(join(migrationsFolder, 'meta', '_journal.json')));
    assert.ok(migrationsFolder.endsWith(join('apps', 'backend', 'drizzle')));
  });

  test('the journal and its files agree', () => {
    const bundled = readBundledMigrations(migrationsFolder);
    assert.equal(bundled.length, 2);
    assert.deepEqual(
      bundled.map((m) => m.tag),
      ['0000_init', '0001_identity_trigger_and_root_areas'],
    );
    for (const migration of bundled) assert.match(migration.hash, /^[0-9a-f]{64}$/);
  });

  test('hashes are sha256 over the raw migration file, as the migrator computes them', () => {
    // Derived independently here. If this diverged from Drizzle's own derivation, every database
    // would look incompatible on the next start.
    const bundled = readBundledMigrations(migrationsFolder);
    withMigrated('hash', ({ db }) => {
      const applied = many<{ hash: string; created_at: number }>(
        db,
        'SELECT hash, created_at FROM __drizzle_migrations',
      );
      assert.deepEqual(applied.map((r) => r.hash).sort(), bundled.map((m) => m.hash).sort());
    });
  });
});

describe('initialization', () => {
  test('a blank database reaches the bundled version with two root areas', () => {
    withMigrated('init', ({ db }) => {
      const roots = db
        .prepare('SELECT type, slug, title, revision, body FROM nodes ORDER BY id')
        .all();
      assert.deepEqual(roots, [
        { type: 'area', slug: 'work', title: 'Work', revision: 1, body: EMPTY_BODY },
        { type: 'area', slug: 'personal', title: 'Personal', revision: 1, body: EMPTY_BODY },
      ]);
    });
  });

  test('the seeded body still equals the content package canonical empty document', () => {
    // The migration embeds this literal deliberately, so it cannot drift with a TypeScript helper.
    // When this assertion eventually fails, the answer is a new forward migration that rewrites stored
    // bodies and a comparison updated to the fully migrated result - never an edit to the applied file.
    withMigrated('drift', ({ db }) => {
      const stored = one<{ body: string }>(
        db,
        'SELECT body FROM nodes WHERE slug = ?',
        'work',
      ).body;
      assert.deepEqual(JSON.parse(stored), createEmptyDocument());
    });
  });

  test('seed rows share one sampled instant taken during migration', () => {
    const before = Date.now();
    withMigrated('clock', ({ db }) => {
      const rows = many<{ created_at: number; updated_at: number }>(
        db,
        'SELECT DISTINCT created_at, updated_at FROM nodes',
      );
      assert.equal(rows.length, 1, 'both seed rows must carry the same timestamp');
      assert.equal(rows[0]!.created_at, rows[0]!.updated_at);
      assert.ok(rows[0]!.created_at >= before, 'timestamp must come from migration execution');
      assert.ok(rows[0]!.created_at <= Date.now());
    });
  });

  test('seed ids are not fixed and are never depended upon', () => {
    withMigrated('ids', ({ db }) => {
      const ids = many<{ id: number }>(db, 'SELECT id FROM nodes ORDER BY id').map((r) => r.id);
      for (const id of ids) assert.ok(Number.isSafeInteger(id) && id > 0);
    });
  });

  test('reopening and re-migrating does not duplicate the seed', () => {
    const temp = tempDatabase('reopen');
    try {
      const first = openMigrated(temp.file);
      insertNode(first.db, { type: 'project', parentId: 1, parentType: 'area', slug: 'kept' });
      first.close();

      const second = openMigrated(temp.file);
      try {
        assert.equal(
          count(second.db, `SELECT count(*) AS c FROM nodes WHERE parent_id IS NULL`),
          2,
        );
        assert.equal(count(second.db, `SELECT count(*) AS c FROM nodes WHERE slug = 'kept'`), 1);
        assert.deepEqual(
          inspectMigrationHistory(second.db, readBundledMigrations(migrationsFolder)),
          {
            state: 'current',
            applied: 2,
          },
        );
      } finally {
        second.close();
      }
    } finally {
      temp.cleanup();
    }
  });
});

describe('migration history guard', () => {
  test('a nonempty database with no Raphael history is refused', () => {
    const temp = tempDatabase('foreign');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec('CREATE TABLE someone_elses_notes (id INTEGER PRIMARY KEY, body TEXT)');
      rejects(() => migrateToLatest(connection.db), /not a Raphael database/);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('an empty Drizzle receipt table does not make a foreign database ours', () => {
    // `__drizzle_migrations` is the default name for every Drizzle project, so its presence proves
    // only that some Drizzle application has been here. Treating the name as ownership would let
    // Raphael write its tables into another application's database.
    const temp = tempDatabase('foreign-receipts');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec('CREATE TABLE someone_elses_notes (id INTEGER PRIMARY KEY, body TEXT)');
      connection.db.exec(
        `CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      rejects(() => migrateToLatest(connection.db), /not a Raphael database/);
      const tables = many<{ name: string }>(
        connection.db,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).map((t) => t.name);
      assert.deepEqual(
        tables,
        ['__drizzle_migrations', 'someone_elses_notes'],
        'nothing was written',
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  describe('foreign receipt-table shapes', () => {
    // The receipt table's *schema* is untrusted boundary data for the same reason its name is:
    // `__drizzle_migrations` is shared across Drizzle applications and versions. Every variant must
    // leave a typed, actionable failure rather than a raw SqliteError, and must change nothing.
    const objectsIn = (db: import('better-sqlite3').Database): string[] =>
      many<{ o: string }>(
        db,
        `SELECT type || ':' || name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY o`,
      ).map((r) => r.o);

    const refusesAndLeavesAlone = (tag: string, setup: string[], expectedReason: string): void => {
      const temp = tempDatabase(tag);
      const connection = openDatabase({ databasePath: temp.file });
      try {
        for (const statement of setup) connection.db.exec(statement);
        const before = objectsIn(connection.db);

        const error = (() => {
          try {
            migrateToLatest(connection.db);
            return undefined;
          } catch (caught) {
            return caught as MigrationHistoryError;
          }
        })();

        assert.ok(
          error instanceof MigrationHistoryError,
          `expected a typed migration failure, got ${error?.constructor.name ?? 'no error'}`,
        );
        assert.equal(error.reason, expectedReason);
        assert.match(error.message, /point the configured database path at a new file/i);
        assert.deepEqual(objectsIn(connection.db), before, 'nothing may be created or altered');
      } finally {
        connection.close();
        temp.cleanup();
      }
    };

    test('a version-skewed receipt schema beside foreign data is unrelated, not a raw SQL error', () => {
      refusesAndLeavesAlone(
        'skew-foreign',
        [
          'CREATE TABLE someone_elses_notes (id INTEGER PRIMARY KEY, body TEXT)',
          `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, applied_at numeric)`,
        ],
        'unrelated_database',
      );
    });

    test('a version-skewed receipt schema alone is a malformed history', () => {
      refusesAndLeavesAlone(
        'skew-alone',
        [
          `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, applied_at numeric)`,
        ],
        'receipt_malformed',
      );
    });

    test('a view carrying the receipt name is refused', () => {
      refusesAndLeavesAlone(
        'receipt-view',
        [`CREATE VIEW __drizzle_migrations AS SELECT 1 AS hash, 2 AS created_at`],
        'receipt_malformed',
      );
    });

    test('a receipt table missing only the hash column is refused', () => {
      refusesAndLeavesAlone(
        'no-hash',
        [`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, created_at numeric)`],
        'receipt_malformed',
      );
    });
  });

  test('a foreign view is enough to refuse adoption', () => {
    const temp = tempDatabase('foreign-view');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      connection.db.exec('CREATE VIEW their_view AS SELECT * FROM t');
      connection.db.exec('DROP TABLE t');
      rejects(() => migrateToLatest(connection.db), /not a Raphael database/);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test("another Drizzle application's applied history is refused", () => {
    // A nonempty history that is not ours fails the prefix comparison rather than being adopted.
    const temp = tempDatabase('foreign-history');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec(
        `CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      connection.db
        .prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
        .run('b'.repeat(64), 1_600_000_000_000);
      rejects(() => migrateToLatest(connection.db), /does not match this backend's migration/);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('an empty receipt table on an otherwise empty database is adopted', () => {
    // The complement of the case above: a receipt table with nothing else is not someone's data.
    const temp = tempDatabase('empty-receipts');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec(
        `CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      assert.deepEqual(
        inspectMigrationHistory(connection.db, readBundledMigrations(migrationsFolder)),
        {
          state: 'fresh',
        },
      );
      migrateToLatest(connection.db);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), 2);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('a database migrated by a newer build is refused', () => {
    withMigrated('newer', ({ db }) => {
      db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(
        'f'.repeat(64),
        9_999_999_999_999,
      );
      rejects(
        () => inspectMigrationHistory(db, readBundledMigrations(migrationsFolder)),
        /migrated by a newer Raphael build/,
      );
    });
  });

  test('changed SQL for an already applied migration is refused', () => {
    const temp = tempDatabase('tamper');
    const connection = openMigrated(temp.file);
    try {
      const tampered = join(temp.dir, 'drizzle');
      cpSync(migrationsFolder, tampered, { recursive: true });
      const file = join(tampered, '0001_identity_trigger_and_root_areas.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- changed after it was applied\n`);
      rejects(
        () => inspectMigrationHistory(connection.db, readBundledMigrations(tampered)),
        /does not match this backend's migration/,
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('an unsafe integer in the receipt table is refused before it is trusted', () => {
    withMigrated('receipt', ({ db }) => {
      db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(
        'a'.repeat(64),
        1.5,
      );
      rejects(
        () => inspectMigrationHistory(db, readBundledMigrations(migrationsFolder)),
        /not a safely representable integer/,
      );
    });
  });

  test('a fresh empty database is recognised as fresh, not as unrelated', () => {
    const temp = tempDatabase('fresh');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      assert.deepEqual(
        inspectMigrationHistory(connection.db, readBundledMigrations(migrationsFolder)),
        {
          state: 'fresh',
        },
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });
});

describe('migration failure', () => {
  test('a broken later migration leaves the database exactly as it was', () => {
    const temp = tempDatabase('rollback');
    const connection = openMigrated(temp.file);
    try {
      insertNode(connection.db, { type: 'project', parentId: 1, parentType: 'area', slug: 'live' });

      const broken = join(temp.dir, 'drizzle');
      cpSync(migrationsFolder, broken, { recursive: true });
      const journalPath = join(broken, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      journal.entries.push({
        idx: 2,
        version: '6',
        when: Date.now(),
        tag: '0002_broken',
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      writeFileSync(
        join(broken, '0002_broken.sql'),
        'ALTER TABLE nodes ADD COLUMN experiment TEXT;\n--> statement-breakpoint\nTHIS IS NOT VALID SQL;',
      );

      rejects(() => migrateToLatest(connection.db, broken), /syntax error|not valid SQL|near/i);

      const columns = many<{ name: string }>(connection.db, 'PRAGMA table_xinfo(nodes)').map(
        (c) => c.name,
      );
      assert.ok(!columns.includes('experiment'), 'partial DDL must not survive');
      assert.equal(count(connection.db, `SELECT count(*) AS c FROM nodes WHERE slug = 'live'`), 1);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM __drizzle_migrations'), 2);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });
});

describe('generated artifact introspection', () => {
  // Structural introspection rather than a byte-exact SQL snapshot: whitespace or a harmless generator
  // spelling change must not read as an integrity regression, and the expectations below are written
  // independently of the declarations that produced them.
  test('columns and nullability match the intended shape', () => {
    withMigrated('columns', ({ db }) => {
      const columns = many<{ name: string; notnull: number }>(db, 'PRAGMA table_xinfo(nodes)').map(
        (c) => `${c.name}:${c.notnull}`,
      );
      assert.deepEqual(columns, [
        'id:1',
        'type:1',
        'parent_id:0',
        'parent_type:0',
        'slug:1',
        'revision:1',
        'title:1',
        'description:1',
        'body:1',
        'tags:1',
        'metadata:1',
        'created_at:1',
        'updated_at:1',
      ]);
    });
  });

  test('the parent reference is composite and restrictive', () => {
    withMigrated('fk', ({ db }) => {
      const fks = many<{ table: string; from: string; to: string; on_delete: string }>(
        db,
        'PRAGMA foreign_key_list(nodes)',
      );
      assert.equal(fks.length, 2, 'one foreign key spanning two columns');
      assert.deepEqual(
        fks.map((f) => `${f.from}->${f.table}.${f.to}`),
        ['parent_id->nodes.id', 'parent_type->nodes.type'],
      );
      for (const fk of fks) assert.equal(fk.on_delete, 'RESTRICT');
    });
  });

  test('sibling slug indexes are unique and partial', () => {
    withMigrated('idx', ({ db }) => {
      const indexes = Object.fromEntries(
        many<{ name: string; unique: number; partial: number }>(db, 'PRAGMA index_list(nodes)').map(
          (i) => [i.name, { unique: i.unique, partial: i.partial }],
        ),
      );
      assert.deepEqual(indexes.nodes_sibling_slug, { unique: 1, partial: 1 });
      assert.deepEqual(indexes.nodes_root_slug, { unique: 1, partial: 1 });
      assert.deepEqual(indexes.nodes_id_type, { unique: 1, partial: 0 });
    });
  });

  test('index collation is binary', () => {
    withMigrated('coll', ({ db }) => {
      const info = many<{ name: string | null; coll: string }>(
        db,
        'PRAGMA index_xinfo(nodes_sibling_slug)',
      );
      const slug = info.find((c) => c.name === 'slug');
      assert.equal(slug?.coll, 'BINARY');
    });
  });

  test('only the intended objects exist', () => {
    withMigrated('objects', ({ db }) => {
      const objects = many<{ type: string; name: string }>(
        db,
        `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).map((o) => `${o.type}:${o.name}`);
      assert.deepEqual(objects, [
        'index:creation_replays_expires_at',
        'index:nodes_id_type',
        'index:nodes_root_slug',
        'index:nodes_sibling_slug',
        'table:__drizzle_migrations',
        'table:creation_replays',
        'table:nodes',
        'trigger:nodes_identity_immutable',
      ]);
    });
  });

  test('the identity trigger guards exactly the intended columns', () => {
    withMigrated('trigger', ({ db }) => {
      const sql = one<{ sql: string }>(
        db,
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'nodes_identity_immutable'`,
      ).sql;
      assert.match(sql, /BEFORE UPDATE OF id, type, created_at/);
      assert.match(sql, /NEW\.id IS NOT OLD\.id/);
      assert.ok(!/parent_id/.test(sql), 'a move must remain possible');
    });
  });

  test('AUTOINCREMENT is real, not inferred from the declaration', () => {
    withMigrated('autoinc', ({ db }) => {
      const sql = one<{ sql: string }>(
        db,
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`,
      ).sql;
      assert.match(sql, /AUTOINCREMENT/);
      assert.equal(count(db, `SELECT count(*) AS c FROM sqlite_sequence WHERE name = 'nodes'`), 1);
    });
  });
});
