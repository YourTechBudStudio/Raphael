import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { MAX_SAFE_DB_INTEGER } from '../src/modules/nodes/schema.ts';
import {
  EMPTY_BODY,
  count,
  insertNode,
  one,
  openMigrated,
  rejects,
  tempDatabase,
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
          .prepare(`INSERT INTO nodes (type, slug, title, body, tags, created_at, updated_at)
        VALUES ('area', 't1', 'T', ?, '{}', 1, 1)`)
          .run(EMPTY_BODY),
      /nodes_tags_json/,
    );
    rejects(
      () =>
        db
          .prepare(`INSERT INTO nodes (type, slug, title, body, metadata, created_at, updated_at)
        VALUES ('area', 'm1', 'T', ?, '[]', 1, 1)`)
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

  test('replay expiry columns carry the same bound', () => {
    rejects(
      () =>
        db
          .prepare(
            `INSERT INTO creation_replays (key, fingerprint, result_json, created_at, expires_at)
             VALUES ('k', 'f', '{}', 1, ?)`,
          )
          .run(MAX_SAFE_DB_INTEGER + 1),
      /creation_replays_expires_at_safe/,
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

  test('the seeded root areas have no kind and no projection until one is derived', () => {
    // Null is "no projection has been derived", which the maintenance pass distinguishes from a body
    // whose text is genuinely empty. The seeds keep their null until that pass reads them.
    const seeds = count(
      db,
      `SELECT count(*) AS c FROM nodes WHERE parent_id IS NULL AND kind IS NULL AND body_text IS NULL`,
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
      'parent_id',
      'parent_type',
      'slug',
      'revision',
      'title',
      'description',
      'body',
      'tags',
      'metadata',
      'created_at',
      'updated_at',
      'kind',
      'body_text',
      'active',
    ]);
  });
});
