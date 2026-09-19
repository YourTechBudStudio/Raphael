import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The node ids the index matches for one term.
 *
 * The term is wrapped in double quotes so FTS5 reads it as a literal string rather than as query
 * syntax - these tests ask what the index holds, never what the query language does with it.
 */
const matching = (db: import('better-sqlite3').Database, term: string): number[] =>
  many<{ id: number }>(
    db,
    `SELECT rowid AS id FROM nodes_fts WHERE nodes_fts MATCH '"${term}"'`,
  ).map((row) => row.id);

describe('migration assets', () => {
  test('resolve relative to the package, not the working directory', () => {
    // A compiled, installed backend is started from an arbitrary directory. If this resolution used
    // process.cwd() the server would find its migrations only when launched from the repository.
    assert.ok(existsSync(join(migrationsFolder, 'meta', '_journal.json')));
    assert.ok(migrationsFolder.endsWith(join('apps', 'backend', 'drizzle')));
  });

  test('the journal and its files agree', () => {
    const bundled = readBundledMigrations(migrationsFolder);
    assert.equal(bundled.length, 5);
    assert.deepEqual(
      bundled.map((m) => m.tag),
      [
        '0000_init',
        '0001_identity_trigger_and_root_areas',
        '0002_resource_kind_and_body_text',
        '0003_active_projects',
        '0004_search_index',
      ],
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

  test('FTS5 is compiled into the SQLite build this backend runs on', () => {
    // The migration is the real guard: `CREATE VIRTUAL TABLE ... USING fts5` fails without FTS5, and
    // the transactional migrator rolls the database back, so a backend that cannot index fails to
    // start. This assertion adds nothing to that guarantee - it buys a failure that names the cause
    // at `pnpm check` time instead of a raw SQL error at first start.
    withMigrated('fts5', ({ db }) => {
      assert.equal(
        one<{ used: number }>(db, `SELECT sqlite_compileoption_used('ENABLE_FTS5') AS used`).used,
        1,
      );
    });
  });

  test('the search index is populated for rows that predate it', () => {
    // `0001` seeds the two root areas long before `0004` exists, so the only thing that can make them
    // searchable is the `rebuild` the migration issues.
    withMigrated('fts-rebuild', ({ db }) => {
      const work = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'work'`).id;
      assert.deepEqual(matching(db, 'work'), [work]);
    });
  });

  test('rebuild is idempotent and leaves a sound index', () => {
    // `rebuild` is the documented recovery from a corrupt external-content index, so running it on an
    // index that is already correct must be safe, and `integrity-check` is how an operator confirms
    // it worked. It raises rather than returning a row when the index disagrees with `nodes`.
    withMigrated('fts-repair', ({ db }) => {
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')`);
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES ('integrity-check')`);
      const work = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'work'`).id;
      assert.deepEqual(matching(db, 'work'), [work]);
    });
  });

  test('the triggers keep the index sound across a row lifecycle', () => {
    // No operation deletes a node today, so the delete trigger ships unreachable from the application
    // - and it is the one whose failure mode is SQLITE_CORRUPT_VTAB, because an external-content table
    // trusts that a 'delete' names content it currently holds. This walks the whole lifecycle against
    // raw SQL, on a row whose `body_text` is null for part of it, and asks the index whether it is
    // still sound. It does not try to *cause* corruption: that would pin SQLite's behaviour rather
    // than ours, and the hazard is recorded in the migration header instead.
    withMigrated('fts-lifecycle', ({ db }) => {
      const work = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'work'`).id;
      // The fixture writes no `body_text`, so this row starts out exactly like one the backfill has
      // not reached: indexed on its title, with an empty body column.
      insertNode(db, {
        type: 'project',
        parentId: work,
        parentType: 'area',
        slug: 'indexed',
        title: 'Indexed project',
      });
      const id = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'indexed'`).id;

      assert.deepEqual(matching(db, 'indexed'), [id], 'the insert trigger indexed the new row');

      // The shape the derived-text backfill writes: `body_text` alone, on a row that had none.
      db.prepare('UPDATE nodes SET body_text = ? WHERE id = ?').run('quarterly planning', id);
      assert.deepEqual(matching(db, 'quarterly'), [id], 'a later projection becomes searchable');

      db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('Renamed project', id);
      assert.deepEqual(matching(db, 'indexed'), [], 'the old title is gone from the index');
      assert.deepEqual(matching(db, 'renamed'), [id], 'and the new one is in it');
      assert.deepEqual(
        matching(db, 'quarterly'),
        [id],
        'a column the update did not touch is unharmed',
      );

      db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
      assert.deepEqual(matching(db, 'renamed'), [], 'the delete trigger un-indexed the row');

      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES ('integrity-check')`);
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
            applied: 5,
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
        idx: 5,
        version: '6',
        when: Date.now(),
        tag: '0005_broken',
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      writeFileSync(
        join(broken, '0005_broken.sql'),
        'ALTER TABLE nodes ADD COLUMN experiment TEXT;\n--> statement-breakpoint\nTHIS IS NOT VALID SQL;',
      );

      rejects(() => migrateToLatest(connection.db, broken), /syntax error|not valid SQL|near/i);

      const columns = many<{ name: string }>(connection.db, 'PRAGMA table_xinfo(nodes)').map(
        (c) => c.name,
      );
      assert.ok(!columns.includes('experiment'), 'partial DDL must not survive');
      assert.equal(count(connection.db, `SELECT count(*) AS c FROM nodes WHERE slug = 'live'`), 1);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM __drizzle_migrations'), 5);
    } finally {
      connection.close();
      temp.cleanup();
    }
  });
});

describe('adding the active column to a populated database', () => {
  test('every existing row reaches 0003 as not selected', () => {
    // The migration that matters is the one onto data that already exists, and `0003` adds a NOT NULL
    // column with a CHECK that reads another column. SQLite evaluates that constraint against every
    // current row and refuses the ALTER if any violates it, so this is the case that proves the
    // default is a value every pre-existing row can actually take - whatever its type.
    const temp = tempDatabase('active-backfill');
    const partial = join(temp.dir, 'through-0002');
    cpSync(migrationsFolder, partial, { recursive: true });
    const journalPath = join(partial, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    // "Through 0002" is expressed as that rule rather than as a list of the tags that happen to
    // follow it today, because a list stops being true the moment a migration is added and does so
    // silently. A fixture still carrying the newest migration applies it in `0003`'s place, and the
    // `migrateToLatest` below then compares that applied hash against the bundled `0003` and refuses
    // the database as changed SQL - failing this test with a message about migration history when
    // the thing under test is a column default.
    const dropped = journal.entries.filter((entry) => entry.idx > 2);
    journal.entries = journal.entries.filter((entry) => entry.idx <= 2);
    writeFileSync(journalPath, JSON.stringify(journal));
    for (const entry of dropped) rmSync(join(partial, `${entry.tag}.sql`));

    const connection = openDatabase({ databasePath: temp.file });
    try {
      migrateToLatest(connection.db, partial);
      const columnsBefore = many<{ name: string }>(connection.db, 'PRAGMA table_xinfo(nodes)').map(
        (c) => c.name,
      );
      assert.ok(!columnsBefore.includes('active'), 'the fixture is genuinely a pre-0003 database');

      // One of each type, so the constraint is evaluated against a row it permits `0` on and a row it
      // would refuse `1` on. Written without the fixture helper, which now knows about the column.
      const work = one<{ id: number }>(
        connection.db,
        `SELECT id FROM nodes WHERE slug = 'work'`,
      ).id;
      const insert = connection.db.prepare(
        `INSERT INTO nodes (type, kind, parent_id, parent_type, slug, title, body, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1700000000000, 1700000000000)`,
      );
      insert.run('area', null, work, 'area', 'reading', 'Reading', EMPTY_BODY);
      insert.run('project', null, work, 'area', 'migration', 'Migration', EMPTY_BODY);
      const project = one<{ id: number }>(
        connection.db,
        `SELECT id FROM nodes WHERE slug = 'migration'`,
      ).id;
      insert.run('resource', 'note', project, 'project', 'a-note', 'A note', EMPTY_BODY);
      const before = count(connection.db, 'SELECT count(*) AS c FROM nodes');

      migrateToLatest(connection.db);

      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), before, 'nothing lost');
      assert.equal(
        count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE active = 0'),
        before,
        'every pre-existing row is not selected, which is the truth about all of them',
      );
      // And the identity trigger `0001` installs survived, which a generated table rebuild would have
      // dropped along with the table it replaced.
      rejects(
        () => connection.db.prepare('UPDATE nodes SET type = ? WHERE id = ?').run('area', project),
        /identity is immutable/i,
      );
      // An FTS assertion in a test about the `active` column is not drift. This is the only fixture in
      // the suite where rows exist *before* `0004` does, so it is the only place that can show the
      // migration's `rebuild` reaching rows no trigger ever saw - and these three were written with a
      // null `body_text`, so it also shows a row indexes on its title alone.
      assert.deepEqual(
        matching(connection.db, 'migration'),
        [project],
        'rebuild indexed rows that predate the index',
      );
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
        // Both nullable, and both deliberately so. A container has no kind; a null projection means
        // no text has been derived for that row yet, which is not the same as text that is empty.
        'kind:0',
        'body_text:0',
        // Not nullable, and there is no third state to represent: every row that predates selection
        // is genuinely not selected, which is what the default `0` says.
        'active:1',
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
        // One virtual table and the four shadow tables FTS5 creates to back it. They are the storage
        // an external-content index needs and are not addressed directly by anything we write.
        'table:nodes_fts',
        'table:nodes_fts_config',
        'table:nodes_fts_data',
        'table:nodes_fts_docsize',
        'table:nodes_fts_idx',
        'trigger:nodes_fts_after_delete',
        'trigger:nodes_fts_after_insert',
        'trigger:nodes_fts_after_update',
        'trigger:nodes_identity_immutable',
      ]);
    });
  });
});
