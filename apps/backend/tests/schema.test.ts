import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { MAX_SAFE_DB_INTEGER } from '../src/modules/nodes/schema.ts';
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
 * Constraint behavior is asserted by executing raw SQL against a migrated database, never by reading
 * the Drizzle declarations back. A declaration is a claim; only the database can confirm it, and the
 * generator sits between the two.
 */
const temp = tempDatabase('schema');
const connection = openMigrated(temp.file);
const db = connection.db;

after(() => {
  connection.close();
  temp.cleanup();
});

// A stable fixture hierarchy. Resources are ordinary stored nodes now, distinguished by their kind.
const WORK = 1;
let subArea: number;
let project: number;
let resource: number;

describe('fixture hierarchy', () => {
  test('seeded root areas are present and addressable', () => {
    const roots = db.prepare('SELECT id, type, slug, title FROM nodes ORDER BY id').all();
    assert.deepEqual(roots, [
      { id: 1, type: 'area', slug: 'work', title: 'Work' },
      { id: 2, type: 'area', slug: 'personal', title: 'Personal' },
    ]);
  });

  test('valid parentage is accepted across the matrix', () => {
    insertNode(db, { type: 'area', parentId: WORK, parentType: 'area', slug: 'sub' });
    subArea = one<{ id: number }>(db, 'SELECT id FROM nodes WHERE slug = ?', 'sub').id;
    insertNode(db, { type: 'project', parentId: WORK, parentType: 'area', slug: 'apollo' });
    project = one<{ id: number }>(db, 'SELECT id FROM nodes WHERE slug = ?', 'apollo').id;
    insertNode(db, { type: 'resource', parentId: project, parentType: 'project', slug: 'spec' });
    resource = one<{ id: number }>(db, 'SELECT id FROM nodes WHERE slug = ?', 'spec').id;
    insertNode(db, { type: 'resource', parentId: WORK, parentType: 'area', slug: 'link' });
    assert.equal(count(db, 'SELECT count(*) AS c FROM nodes'), 6);
  });
});

describe('parentage', () => {
  test('only areas may sit at the root', () => {
    rejects(() => insertNode(db, { type: 'project', slug: 'rootproj' }), /nodes_root_is_area/);
    rejects(() => insertNode(db, { type: 'resource', slug: 'rootres' }), /nodes_root_is_area/);
  });

  test('projects and areas may not live under a project', () => {
    rejects(
      () => insertNode(db, { type: 'area', parentId: project, parentType: 'project', slug: 'bad' }),
      /nodes_allowed_parentage/,
    );
    rejects(
      () =>
        insertNode(db, { type: 'project', parentId: project, parentType: 'project', slug: 'bad' }),
      /nodes_allowed_parentage/,
    );
  });

  test('resources hold no children', () => {
    rejects(
      () =>
        insertNode(db, {
          type: 'resource',
          parentId: resource,
          parentType: 'resource',
          slug: 'bad',
        }),
      /nodes_allowed_parentage/,
    );
  });

  test('a parent_type that misstates the parent is refused by the composite foreign key', () => {
    // The CHECK would happily allow resource-under-project; only the foreign key knows that node 1 is
    // an area, not a project. This is the constraint that keeps the duplicated column honest.
    rejects(
      () =>
        insertNode(db, { type: 'resource', parentId: WORK, parentType: 'project', slug: 'liar' }),
      /FOREIGN KEY constraint failed/,
    );
  });

  test('a parent reference must name a row that exists', () => {
    rejects(
      () =>
        insertNode(db, { type: 'project', parentId: 99_999, parentType: 'area', slug: 'ghost' }),
      /FOREIGN KEY constraint failed/,
    );
  });

  test('parent id and parent type are populated together or not at all', () => {
    rejects(
      () => insertNode(db, { type: 'project', parentId: WORK, slug: 'half' }),
      /nodes_parent_pair/,
    );
    rejects(
      () => insertNode(db, { type: 'area', parentType: 'area', slug: 'half' }),
      /nodes_parent_pair/,
    );
  });

  test('a node cannot be its own parent', () => {
    rejects(
      () =>
        insertNode(db, { id: 500, type: 'area', parentId: 500, parentType: 'area', slug: 'self' }),
      /nodes_not_self_parent|FOREIGN KEY/,
    );
  });

  test('deleting a parent that still has children is refused', () => {
    rejects(
      () => db.prepare('DELETE FROM nodes WHERE id = ?').run(WORK),
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe('sibling slug namespace', () => {
  test('siblings collide regardless of type', () => {
    rejects(
      () => insertNode(db, { type: 'project', parentId: WORK, parentType: 'area', slug: 'sub' }),
      /UNIQUE constraint failed/,
    );
  });

  test('root siblings collide', () => {
    rejects(() => insertNode(db, { type: 'area', slug: 'work' }), /UNIQUE constraint failed/);
  });

  test('the same slug under different parents is fine', () => {
    insertNode(db, { type: 'resource', parentId: subArea, parentType: 'area', slug: 'spec' });
    assert.equal(count(db, 'SELECT count(*) AS c FROM nodes WHERE slug = ?', 'spec'), 2);
  });

  test('slug comparison is binary, never case-insensitive', () => {
    // If the index were NOCASE this would collide. Canonicalization happens before storage, so ASCII
    // case folding here would only add a guarantee the slug grammar already expresses.
    insertNode(db, { type: 'resource', parentId: subArea, parentType: 'area', slug: 'Spec' });
    assert.equal(count(db, 'SELECT count(*) AS c FROM nodes WHERE parent_id = ?', subArea), 2);
  });
});

describe('authored field integrity', () => {
  test('title and slug must be present', () => {
    rejects(() => insertNode(db, { type: 'area', slug: 'x', title: '' }), /nodes_title_present/);
    rejects(() => insertNode(db, { type: 'area', slug: '' }), /nodes_slug_present/);
  });

  test('body must be a JSON object', () => {
    rejects(
      () => insertNode(db, { type: 'area', slug: 'j1', body: 'not json' }),
      /nodes_body_json/,
    );
    rejects(() => insertNode(db, { type: 'area', slug: 'j2', body: '[]' }), /nodes_body_json/);
    rejects(() => insertNode(db, { type: 'area', slug: 'j3', body: '"text"' }), /nodes_body_json/);
  });

  test('tags must be a JSON array and metadata a JSON object', () => {
    rejects(
      () =>
        db
          .prepare(`INSERT INTO nodes (type, slug, title, body, body_text, tags, created_at, updated_at)
        VALUES ('area', 't1', 'T', ?, '', '{}', 1, 1)`)
          .run(EMPTY_BODY),
      /nodes_tags_json/,
    );
    rejects(
      () =>
        db
          .prepare(`INSERT INTO nodes (type, slug, title, body, body_text, metadata, created_at, updated_at)
        VALUES ('area', 'm1', 'T', ?, '', '[]', 1, 1)`)
          .run(EMPTY_BODY),
      /nodes_metadata_json/,
    );
  });

  test('unsupported types are refused', () => {
    rejects(() => insertNode(db, { type: 'note', slug: 'n1' }), /nodes_type_supported/);
  });

  test('defaults materialize revision, description, tags and metadata', () => {
    const row = one<Record<string, unknown>>(
      db,
      'SELECT revision, description, tags, metadata FROM nodes WHERE id = ?',
      WORK,
    );
    assert.deepEqual(row, { revision: 1, description: '', tags: '[]', metadata: '{}' });
  });
});

describe('integer safety', () => {
  // better-sqlite3 converts 64-bit integers into JavaScript numbers, rounding anything above the safe
  // range. A rounded ID still looks like a valid positive integer downstream, so it would pass
  // contract validation while naming a different row. The bound is enforced here, where it is exact.
  test('an explicit id beyond the safe range is refused', () => {
    rejects(
      () => insertNode(db, { id: MAX_SAFE_DB_INTEGER + 1, type: 'area', slug: 'huge' }),
      /nodes_id_safe/,
    );
  });

  test('a generated id beyond the safe range is refused', () => {
    // Drive AUTOINCREMENT to the boundary, then let it generate the next value.
    db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(
      MAX_SAFE_DB_INTEGER,
      'nodes',
    );
    rejects(() => insertNode(db, { type: 'area', slug: 'generated-overflow' }), /nodes_id_safe/);
    db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(200, 'nodes');
  });

  test('revision and timestamps must be safe integers', () => {
    rejects(
      () => insertNode(db, { type: 'area', slug: 'r1', revision: MAX_SAFE_DB_INTEGER + 1 }),
      /nodes_revision_safe/,
    );
    rejects(() => insertNode(db, { type: 'area', slug: 'r2', revision: 0 }), /nodes_revision_safe/);
    rejects(
      () => insertNode(db, { type: 'area', slug: 't1', createdAt: MAX_SAFE_DB_INTEGER + 1 }),
      /nodes_created_at_safe/,
    );
  });

  test('a non-integral timestamp is refused rather than coerced', () => {
    rejects(
      () => insertNode(db, { type: 'area', slug: 't2', createdAt: 1.5 }),
      /nodes_created_at_safe/,
    );
  });
});

describe('identity immutability', () => {
  test('id, type and creation time cannot change', () => {
    rejects(
      () => db.prepare('UPDATE nodes SET type = ? WHERE id = ?').run('project', WORK),
      /identity is immutable/,
    );
    rejects(
      () => db.prepare('UPDATE nodes SET id = ? WHERE id = ?').run(9_000, WORK),
      /identity is immutable/,
    );
    rejects(
      () => db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(5, WORK),
      /identity is immutable/,
    );
  });

  test('a no-op assignment is allowed', () => {
    db.prepare('UPDATE nodes SET type = type, id = id, created_at = created_at WHERE id = ?').run(
      WORK,
    );
    assert.equal(
      one<{ type: string }>(db, 'SELECT type FROM nodes WHERE id = ?', WORK).type,
      'area',
    );
  });

  test('revision and updated_at remain mutable', () => {
    db.prepare('UPDATE nodes SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
      1_700_000_000_001,
      WORK,
    );
    const row = one<Record<string, number>>(
      db,
      'SELECT revision, updated_at FROM nodes WHERE id = ?',
      WORK,
    );
    assert.equal(row.revision, 2);
    assert.equal(row.updated_at, 1_700_000_000_001);
  });

  test('a move updates the parent pair atomically', () => {
    db.prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?').run(
      subArea,
      'area',
      project,
    );
    assert.equal(
      one<{ parent_id: number }>(db, 'SELECT parent_id FROM nodes WHERE id = ?', project).parent_id,
      subArea,
    );
    // The child links to its immediate parent only, so relocating the parent leaves the child's row alone.
    assert.equal(
      one<{ parent_id: number }>(db, 'SELECT parent_id FROM nodes WHERE id = ?', resource)
        .parent_id,
      project,
    );
    db.prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?').run(
      WORK,
      'area',
      project,
    );
  });

  test('a parent cannot change type while it is referenced', () => {
    rejects(
      () => db.prepare('UPDATE nodes SET type = ? WHERE id = ?').run('project', WORK),
      /identity is immutable/,
    );
  });
});

describe('identity allocation', () => {
  test('ids are never reused after deletion', () => {
    insertNode(db, { type: 'resource', parentId: subArea, parentType: 'area', slug: 'ephemeral' });
    const created = one<{ id: number }>(db, 'SELECT id FROM nodes WHERE slug = ?', 'ephemeral').id;
    db.prepare('DELETE FROM nodes WHERE id = ?').run(created);
    insertNode(db, { type: 'resource', parentId: subArea, parentType: 'area', slug: 'successor' });
    const next = one<{ id: number }>(db, 'SELECT id FROM nodes WHERE slug = ?', 'successor').id;
    assert.ok(next > created, `expected a fresh id above ${created}, got ${next}`);
  });
});

describe('resource kind', () => {
  test('a resource must carry a kind and a container must not', () => {
    // One column-level CHECK carries both halves. Written as an equality between two booleans, so it
    // can never evaluate to NULL - a NULL CHECK result is treated as satisfied by SQLite, which would
    // let an unclassified resource through.
    rejects(
      () =>
        insertNode(db, {
          type: 'resource',
          kind: null,
          parentId: project,
          parentType: 'project',
          slug: 'unclassified',
        }),
      /nodes_kind_valid|CHECK constraint/i,
    );
    rejects(
      () =>
        insertNode(db, {
          type: 'area',
          kind: 'note',
          parentId: WORK,
          parentType: 'area',
          slug: 'kinded',
        }),
      /nodes_kind_valid|CHECK constraint/i,
    );
  });

  test('the kind vocabulary is closed', () => {
    rejects(
      () =>
        insertNode(db, {
          type: 'resource',
          kind: 'sketch',
          parentId: project,
          parentType: 'project',
          slug: 'unsupported-kind',
        }),
      /nodes_kind_valid|CHECK constraint/i,
    );
  });

  test('the invariant holds on update, not only on insert', () => {
    // A BEFORE UPDATE OF trigger fires only when its columns are named in the statement. A CHECK is
    // evaluated on every update, which is why this is a constraint rather than a trigger.
    rejects(
      () => db.prepare('UPDATE nodes SET kind = NULL WHERE id = ?').run(resource),
      /nodes_kind_valid|CHECK constraint/i,
    );
    rejects(
      () => db.prepare('UPDATE nodes SET kind = ? WHERE id = ?').run('sketch', resource),
      /nodes_kind_valid|CHECK constraint/i,
    );
    rejects(
      () => db.prepare('UPDATE nodes SET kind = ? WHERE id = ?').run('note', project),
      /nodes_kind_valid|CHECK constraint/i,
    );
  });

  test('the seeded root areas have no kind and an empty projection', () => {
    const seeds = count(
      db,
      `SELECT count(*) AS c FROM nodes WHERE parent_id IS NULL AND kind IS NULL AND body_text = ''`,
    );
    assert.equal(seeds >= 2, true);
    assert.equal(
      one<{ body: string }>(db, 'SELECT body FROM nodes WHERE id = ?', WORK).body,
      EMPTY_BODY,
    );
  });
});

describe('active selection', () => {
  // The second type-conditional column on this table, after `kind`, and the second instance of the
  // same pattern: a column CHECK that reads another column of the same row. This is the independent
  // backstop, not the rule that produces a caller's refusal - `updateNode` owns that, because ADR 0007
  // is explicit that a constraint is never a substitute for core validation.
  test('the column defaults to not selected', () => {
    insertNode(db, {
      type: 'project',
      parentId: WORK,
      parentType: 'area',
      slug: 'unselected-by-default',
    });
    assert.equal(
      count(
        db,
        `SELECT count(*) AS c FROM nodes WHERE slug = 'unselected-by-default' AND active = 0`,
      ),
      1,
    );
    // And the rows that predate selection entirely, which the migration had to land somewhere.
    assert.equal(count(db, 'SELECT count(*) AS c FROM nodes WHERE active IS NULL'), 0);
  });

  test('a project may be selected', () => {
    insertNode(db, {
      type: 'project',
      parentId: WORK,
      parentType: 'area',
      slug: 'selected',
      active: 1,
    });
    assert.equal(
      count(db, `SELECT count(*) AS c FROM nodes WHERE slug = 'selected' AND active = 1`),
      1,
    );
  });

  test('nothing but a project may be selected', () => {
    rejects(
      () =>
        insertNode(db, {
          type: 'area',
          parentId: WORK,
          parentType: 'area',
          slug: 'selected-area',
          active: 1,
        }),
      /nodes_active_valid|CHECK constraint/i,
    );
    rejects(
      () =>
        insertNode(db, {
          type: 'resource',
          parentId: project,
          parentType: 'project',
          slug: 'selected-note',
          active: 1,
        }),
      /nodes_active_valid|CHECK constraint/i,
    );
  });

  test('the domain is closed to 0 and 1', () => {
    for (const active of [2, -1]) {
      rejects(
        () =>
          insertNode(db, {
            type: 'project',
            parentId: WORK,
            parentType: 'area',
            slug: `active-${active}`,
            active,
          }),
        /nodes_active_valid|CHECK constraint/i,
      );
    }
  });

  test('the invariant holds on update, so a selected project cannot be retyped away', () => {
    // A CHECK is evaluated on every update, whether or not `active` is the column being written. That
    // is the property that makes this stronger than a `BEFORE UPDATE OF active` trigger would be.
    const selected = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'selected'`).id;
    rejects(
      () => db.prepare('UPDATE nodes SET active = 1 WHERE id = ?').run(WORK),
      /nodes_active_valid|CHECK constraint/i,
    );
    rejects(
      () => db.prepare('UPDATE nodes SET active = 2 WHERE id = ?').run(selected),
      /nodes_active_valid|CHECK constraint/i,
    );
    // Retyping a selected project away is refused, but not by this constraint: `0001`'s identity
    // trigger fires first and refuses *any* type change, selected or not. The CHECK would catch it
    // otherwise, and stays as the backstop for a database where that trigger is absent. Asserting the
    // reason actually given, rather than the one this rule would have given, is the point.
    rejects(
      () => db.prepare('UPDATE nodes SET type = ? WHERE id = ?').run('area', selected),
      /identity is immutable/i,
    );
  });

  test('selection carries no count, ordinal, timestamp or expiry anywhere on the row', () => {
    // Criterion 4 is an absence, so it is held by enumeration rather than by a behavioural test: the
    // complete column list is the evidence that no cap, no ordering position and no expiry exists to
    // be enforced, and any future addition has to change this list to get in.
    const columns = db
      .prepare('PRAGMA table_xinfo(nodes)')
      .all()
      .map((c) => (c as { name: string }).name);
    assert.deepEqual(
      columns.filter((name) => name.startsWith('active')),
      ['active'],
    );
    assert.deepEqual(columns, [
      'id',
      'type',
      'kind',
      'parent_id',
      'parent_type',
      'slug',
      'revision',
      'title',
      'description',
      'body',
      'tags',
      'active',
      'metadata',
      'created_at',
      'updated_at',
      'body_text',
    ]);
  });
});

describe('archive causes', () => {
  // Rows are written here directly: this suite asks what the table permits, not what `lifecycle.ts`
  // chooses to write.
  const cause = (nodeId: number, owner = 'user', reason = 'direct', createdAt: number = 1) =>
    db
      .prepare(
        'INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(nodeId, owner, reason, createdAt);
  let target: number;

  test('one owner holds one reason on one node at most', () => {
    insertNode(db, { type: 'project', parentId: WORK, parentType: 'area', slug: 'held' });
    target = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'held'`).id;
    cause(target);
    rejects(() => cause(target), /UNIQUE constraint failed|PRIMARY KEY/);
    // Another owner, or another reason, is an independent cause.
    cause(target, 'ext_calendar', 'direct');
    cause(target, 'user', 'expired');
    assert.equal(
      count(db, 'SELECT count(*) AS c FROM archive_causes WHERE node_id = ?', target),
      3,
    );
  });

  test('a node with causes cannot be deleted, and a cause must name a node', () => {
    rejects(
      () => db.prepare('DELETE FROM nodes WHERE id = ?').run(target),
      /FOREIGN KEY constraint failed/,
    );
    rejects(() => cause(999_999), /FOREIGN KEY constraint failed/);
  });

  test('owner and reason are present and bounded, and the timestamp is a safe integer', () => {
    rejects(() => cause(target, '', 'r1'), /archive_causes_owner_present/);
    rejects(() => cause(target, 'o'.repeat(65), 'r1'), /archive_causes_owner_present/);
    rejects(() => cause(target, 'user', ''), /archive_causes_reason_present/);
    rejects(() => cause(target, 'user', 'r'.repeat(65)), /archive_causes_reason_present/);
    cause(target, 'o'.repeat(64), 'r'.repeat(64));
    rejects(
      () => cause(target, 'user', 'r2', MAX_SAFE_DB_INTEGER + 1),
      /archive_causes_created_at_safe/,
    );
    rejects(() => cause(target, 'user', 'r3', 1.5), /archive_causes_created_at_safe/);
    rejects(() => cause(target, 'user', 'r4', -1), /archive_causes_created_at_safe/);
  });
});

describe('favorites', () => {
  // Rows are written here directly: this suite asks what the table permits, not what `favorites.ts`
  // chooses to write.
  const favorite = (nodeId: number) =>
    db.prepare('INSERT INTO favorites (node_id) VALUES (?)').run(nodeId);
  let target: number;

  test('a node is a favorite at most once', () => {
    insertNode(db, { type: 'project', parentId: WORK, parentType: 'area', slug: 'starred' });
    target = one<{ id: number }>(db, `SELECT id FROM nodes WHERE slug = 'starred'`).id;
    favorite(target);
    rejects(() => favorite(target), /UNIQUE constraint failed|PRIMARY KEY/);
    assert.equal(count(db, 'SELECT count(*) AS c FROM favorites WHERE node_id = ?', target), 1);
  });

  test('a favorited node cannot be deleted, and a favorite must name a node', () => {
    rejects(
      () => db.prepare('DELETE FROM nodes WHERE id = ?').run(target),
      /FOREIGN KEY constraint failed/,
    );
    rejects(() => favorite(999_999), /FOREIGN KEY constraint failed/);
  });

  test('favoriting leaves the node row untouched', () => {
    const before = one(db, 'SELECT revision, updated_at FROM nodes WHERE id = ?', WORK);
    favorite(WORK);
    assert.deepEqual(one(db, 'SELECT revision, updated_at FROM nodes WHERE id = ?', WORK), before);
  });
});

/** A fresh migrated database, so these assertions see nothing the fixtures above inserted. */
const withMigratedDb = (body: (fresh: import('better-sqlite3').Database) => void): void =>
  withMigrated('schema-shape', (migrated) => body(migrated.db));

describe('the migrated schema, stated explicitly', () => {
  // Structural introspection rather than a byte-exact SQL snapshot, written independently of the
  // declarations and migrations that produced it.
  test('columns and nullability match the intended shape', () => {
    withMigratedDb((fresh) => {
      const columns = many<{ name: string; notnull: number }>(
        fresh,
        'PRAGMA table_xinfo(nodes)',
      ).map((c) => `${c.name}:${c.notnull}`);
      assert.deepEqual(columns, [
        'id:1',
        'type:1',
        // A container has no kind.
        'kind:0',
        'parent_id:0',
        'parent_type:0',
        'slug:1',
        'revision:1',
        'title:1',
        'description:1',
        'body:1',
        'tags:1',
        'active:1',
        'metadata:1',
        'created_at:1',
        'updated_at:1',
        'body_text:1',
      ]);
    });
  });

  test('the parent reference is composite and restrictive', () => {
    withMigratedDb((fresh) => {
      const fks = many<{ table: string; from: string; to: string; on_delete: string }>(
        fresh,
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
    withMigratedDb((fresh) => {
      const indexes = Object.fromEntries(
        many<{ name: string; unique: number; partial: number }>(
          fresh,
          'PRAGMA index_list(nodes)',
        ).map((i) => [i.name, { unique: i.unique, partial: i.partial }]),
      );
      assert.deepEqual(indexes.nodes_sibling_slug, { unique: 1, partial: 1 });
      assert.deepEqual(indexes.nodes_root_slug, { unique: 1, partial: 1 });
      assert.deepEqual(indexes.nodes_id_type, { unique: 1, partial: 0 });
    });
  });

  test('index collation is binary', () => {
    withMigratedDb((fresh) => {
      const info = many<{ name: string | null; coll: string }>(
        fresh,
        'PRAGMA index_xinfo(nodes_sibling_slug)',
      );
      const slug = info.find((c) => c.name === 'slug');
      assert.equal(slug?.coll, 'BINARY');
    });
  });

  test('only the intended objects exist', () => {
    withMigratedDb((fresh) => {
      const objects = many<{ type: string; name: string }>(
        fresh,
        `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).map((o) => `${o.type}:${o.name}`);
      assert.deepEqual(objects, [
        'index:nodes_id_type',
        'index:nodes_root_slug',
        'index:nodes_sibling_slug',
        'table:__drizzle_migrations',
        // Archive causes, stored only at their origin. Its composite primary key is the only index it
        // needs, and it adds nothing to `nodes`.
        'table:archive_causes',
        // Favorites, one row per favorited node. Its primary key is the only index it needs, and it
        // adds nothing to `nodes`.
        'table:favorites',
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
  test('every named constraint is in place', () => {
    withMigratedDb((fresh) => {
      const named = (table: string): string[] =>
        [
          ...one<{ sql: string }>(
            fresh,
            `SELECT sql FROM sqlite_master WHERE name = ?`,
            table,
          ).sql.matchAll(/CONSTRAINT "(\w+)"/gu),
        ]
          .map((match) => match[1]!)
          .sort();
      assert.deepEqual(named('nodes'), [
        'nodes_active_valid',
        'nodes_allowed_parentage',
        'nodes_body_json',
        'nodes_created_at_safe',
        'nodes_id_safe',
        'nodes_kind_valid',
        'nodes_metadata_json',
        'nodes_not_self_parent',
        'nodes_parent_pair',
        'nodes_revision_safe',
        'nodes_root_is_area',
        'nodes_slug_present',
        'nodes_tags_json',
        'nodes_title_present',
        'nodes_type_supported',
        'nodes_updated_at_safe',
      ]);
      assert.deepEqual(named('archive_causes'), [
        'archive_causes_created_at_safe',
        'archive_causes_owner_present',
        'archive_causes_reason_present',
      ]);
    });
  });

  test('the triggers cover identity and the three index maintenance events', () => {
    withMigratedDb((fresh) => {
      const triggers = many<{ name: string; sql: string }>(
        fresh,
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
      );
      const byName = Object.fromEntries(triggers.map((t) => [t.name, t.sql]));
      assert.match(
        byName['nodes_identity_immutable'] ?? '',
        /BEFORE UPDATE OF id, type, created_at ON nodes/u,
      );
      assert.match(byName['nodes_fts_after_insert'] ?? '', /AFTER INSERT ON nodes/u);
      assert.match(byName['nodes_fts_after_delete'] ?? '', /AFTER DELETE ON nodes/u);
      assert.match(
        byName['nodes_fts_after_update'] ?? '',
        /AFTER UPDATE OF title, description, body_text ON nodes/u,
      );
    });
  });

  test('a fresh database holds exactly the two root areas, with an empty projection', () => {
    withMigratedDb((fresh) => {
      assert.deepEqual(
        many(
          fresh,
          'SELECT type, kind, parent_id, slug, title, body, body_text, active FROM nodes ORDER BY id',
        ),
        [
          {
            type: 'area',
            kind: null,
            parent_id: null,
            slug: 'work',
            title: 'Work',
            body: EMPTY_BODY,
            body_text: '',
            active: 0,
          },
          {
            type: 'area',
            kind: null,
            parent_id: null,
            slug: 'personal',
            title: 'Personal',
            body: EMPTY_BODY,
            body_text: '',
            active: 0,
          },
        ],
      );
    });
  });
});
