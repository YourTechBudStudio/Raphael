import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import { openDatabase } from '../src/infrastructure/database/connection.ts';
import {
  MigrationHistoryError,
  migrateToLatest,
  migrationsFolder,
} from '../src/infrastructure/database/migrate.ts';
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

  test('every journal entry is applied, and nothing else', () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    assert.deepEqual(
      journal.entries.map((entry) => entry.tag),
      ['0000_init', '0001_triggers_and_seed'],
    );
    withMigrated('applied', ({ db }) => {
      const applied = many<{ created_at: number }>(
        db,
        'SELECT created_at FROM __drizzle_migrations ORDER BY created_at',
      );
      assert.deepEqual(
        applied.map((row) => Number(row.created_at)),
        journal.entries.map((entry) => entry.when),
      );
    });
  });
});

describe('initialization', () => {
  test('a blank database reaches the bundled version with two root areas', () => {
    withMigrated('init', ({ db }) => {
      const roots = db
        .prepare('SELECT type, kind, slug, title, revision, body, body_text FROM nodes ORDER BY id')
        .all();
      const root = { type: 'area', kind: null, revision: 1, body: EMPTY_BODY, body_text: '' };
      assert.deepEqual(roots, [
        { ...root, slug: 'work', title: 'Work' },
        { ...root, slug: 'personal', title: 'Personal' },
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

  test('the seeded root areas are indexed by the insert trigger', () => {
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
    // raw SQL and asks the index whether it is still sound.
    withMigrated('fts-lifecycle', ({ db }) => {
      const work = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'work'`).id;
      insertNode(db, {
        type: 'project',
        parentId: work,
        parentType: 'area',
        slug: 'indexed',
        title: 'Indexed project',
      });
      const id = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'indexed'`).id;

      assert.deepEqual(matching(db, 'indexed'), [id], 'the insert trigger indexed the new row');

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
        assert.equal(count(second.db, 'SELECT count(*) AS c FROM __drizzle_migrations'), 2);
      } finally {
        second.close();
      }
    } finally {
      temp.cleanup();
    }
  });
});

describe('migration history guard', () => {
  const refused = (run: () => void): MigrationHistoryError => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof MigrationHistoryError, `expected a refusal, got ${String(error)}`);
      return error;
    }
    throw new Error('expected the database to be refused');
  };

  test('a database migrated by a newer build is refused with a clear message', () => {
    withMigrated('newer', ({ db }) => {
      db.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`).run(
        'f'.repeat(64),
        9_999_999_999_999,
      );
      const error = refused(() => migrateToLatest(db));
      assert.match(error.message, /9999999999999/);
      assert.match(error.message, /newer or different Raphael build/);
      assert.match(error.message, /Upgrade the backend, or point the database path at a new file/);
    });
  });

  test('a history this build does not know is refused, and nothing is written', () => {
    const temp = tempDatabase('foreign-history');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      connection.db.exec(
        `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      connection.db
        .prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
        .run('b'.repeat(64), 1_600_000_000_000);
      refused(() => migrateToLatest(connection.db));
      assert.equal(
        count(connection.db, `SELECT count(*) AS c FROM sqlite_master WHERE name = 'nodes'`),
        0,
      );
    } finally {
      connection.close();
      temp.cleanup();
    }
  });

  test('an older database from this build line is brought up to date', () => {
    const temp = tempDatabase('pending');
    const connection = openDatabase({ databasePath: temp.file });
    try {
      const first = join(temp.dir, 'drizzle');
      cpSync(migrationsFolder, first, { recursive: true });
      const journalPath = join(first, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      journal.entries = journal.entries.slice(0, 1);
      writeFileSync(journalPath, JSON.stringify(journal));

      migrateToLatest(connection.db, first);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), 0);
      migrateToLatest(connection.db);
      assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), 2);
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
