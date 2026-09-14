import assert from 'node:assert/strict';
import test from 'node:test';

import { compareNodeOrder } from '@raphael/contracts/nodes';

import { createNode, listNodes, toPublicError } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  expectLeft,
  expectRight,
  insertNode,
  many,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

const T0 = 1_700_000_000_000;

const make = (
  connection: Parameters<typeof runNodes>[0],
  type: 'area' | 'project',
  parent: unknown,
  title: string,
) => expectRight(runNodes(connection, createNode({ type, parent, title }), clockAt(T0))).entity;

const list = (connection: Parameters<typeof runNodes>[0], request: unknown) =>
  runNodes(connection, listNodes(request));

const slugsOf = (response: { items: readonly { slug: string }[] }) =>
  response.items.map((item) => item.slug);

test('the root scope lists top-level areas, and defaults are materialized', () => {
  withMigrated('list-root', (connection) => {
    const response = expectRight(list(connection, { parent: { path: '/' } }));
    assert.deepEqual(slugsOf(response), ['personal', 'work']);
    assert.equal(response.skip, 0);
    assert.equal(response.limit, 50);
    assert.equal(response.hasMore, false);
  });
});

test('children are ordered by slug then id, under binary collation', () => {
  withMigrated('list-order', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    for (const title of ['delta', 'alpha', 'charlie', 'bravo']) {
      make(connection, 'project', { id: work }, title);
    }

    const response = expectRight(list(connection, { parent: { id: work } }));
    assert.deepEqual(slugsOf(response), ['alpha', 'bravo', 'charlie', 'delta']);

    // The same order the shared comparator produces, so nothing outside SQL disagrees with the query.
    const sorted = [...response.items].sort(compareNodeOrder);
    assert.deepEqual(
      sorted.map((item) => item.slug),
      slugsOf(response),
    );
  });
});

test('slug ordering is binary rather than case-folded', () => {
  withMigrated('list-collation', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    // Canonical slugs are lowercase, so an uppercase sibling is only reachable through direct SQL. It is
    // storage-only data: it would fail the response contract, so it is asserted at the SQL level instead
    // of through an operation, and kept out of every listing test that reads through core.
    insertNode(connection.db, {
      type: 'project',
      parentId: work,
      parentType: 'area',
      slug: 'Spec',
    });
    insertNode(connection.db, {
      type: 'project',
      parentId: work,
      parentType: 'area',
      slug: 'spec',
    });

    const rows = many<{ slug: string }>(
      connection.db,
      'SELECT slug FROM nodes WHERE parent_id = ? ORDER BY slug, id',
      work,
    );
    assert.deepEqual(
      rows.map((row) => row.slug),
      ['Spec', 'spec'],
      'BINARY puts every uppercase letter before every lowercase one; NOCASE would collide them',
    );
  });
});

test('pagination reports hasMore from an observed extra row, not a count', () => {
  withMigrated('list-pagination', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    for (const title of ['one', 'two', 'three', 'four', 'five']) {
      make(connection, 'project', { id: work }, title);
    }

    const first = expectRight(list(connection, { parent: { id: work }, limit: 2 }));
    assert.deepEqual(slugsOf(first), ['five', 'four']);
    assert.equal(first.hasMore, true);
    assert.equal(first.limit, 2);

    const second = expectRight(list(connection, { parent: { id: work }, limit: 2, skip: 2 }));
    assert.deepEqual(slugsOf(second), ['one', 'three']);
    assert.equal(second.hasMore, true);

    const third = expectRight(list(connection, { parent: { id: work }, limit: 2, skip: 4 }));
    assert.deepEqual(slugsOf(third), ['two']);
    assert.equal(third.hasMore, false, 'the last page says so without a second query to check');
    assert.equal(third.skip, 4);

    const past = expectRight(list(connection, { parent: { id: work }, limit: 2, skip: 99 }));
    assert.deepEqual(slugsOf(past), []);
    assert.equal(past.hasMore, false);
  });
});

test('a type filter narrows results without pruning traversal', () => {
  withMigrated('list-filter-recursion', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const outer = make(connection, 'area', { id: work }, 'Outer');
    const inner = make(connection, 'area', { id: outer.id }, 'Inner');
    make(connection, 'project', { id: inner.id }, 'Buried project');
    make(connection, 'project', { id: work }, 'Shallow project');

    const projectsOnly = expectRight(
      list(connection, { parent: { id: work }, recursive: true, types: ['project'] }),
    );
    assert.deepEqual(
      slugsOf(projectsOnly),
      ['buried-project', 'shallow-project'],
      'the walk must pass through areas to reach a project that is not a direct child',
    );

    const areasOnly = expectRight(
      list(connection, { parent: { id: work }, recursive: true, types: ['area'] }),
    );
    assert.deepEqual(slugsOf(areasOnly), ['inner', 'outer']);

    const immediate = expectRight(list(connection, { parent: { id: work }, types: ['project'] }));
    assert.deepEqual(slugsOf(immediate), ['shallow-project']);
  });
});

test('a recursive listing is flat and globally ordered, not depth-first', () => {
  withMigrated('list-recursive-order', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const zulu = make(connection, 'area', { id: work }, 'Zulu');
    make(connection, 'project', { id: zulu.id }, 'Alpha');
    make(connection, 'project', { id: work }, 'Mike');

    const response = expectRight(list(connection, { parent: { id: work }, recursive: true }));
    assert.deepEqual(
      slugsOf(response),
      ['alpha', 'mike', 'zulu'],
      'a descendant sorts before its own ancestor when its slug does',
    );
  });
});

test('recursion from the root reaches every supported descendant', () => {
  withMigrated('list-root-recursion', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const nested = make(connection, 'area', { id: work }, 'Nested');
    make(connection, 'project', { id: nested.id }, 'Deep');

    const response = expectRight(list(connection, { parent: { path: '/' }, recursive: true }));
    assert.deepEqual(slugsOf(response), ['deep', 'nested', 'personal', 'work']);
  });
});

test('the scope node is never one of its own results', () => {
  withMigrated('list-excludes-scope', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const child = make(connection, 'area', { id: work }, 'Child');

    const before = expectRight(list(connection, { parent: { id: work }, recursive: true }));
    assert.deepEqual(slugsOf(before), ['child']);

    // Close a cycle so the scope becomes reachable from its own descendants.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(child.id, 'area', work);

    const after = expectRight(list(connection, { parent: { id: work }, recursive: true }));
    assert.deepEqual(
      slugsOf(after),
      ['child'],
      'identity deduplication terminates the walk, and the scope is excluded even when reachable again',
    );
  });
});

test('unexposed stored types never appear in a page, and are excluded before it is cut', () => {
  withMigrated('list-hides-resources', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const project = make(connection, 'project', { id: work }, 'Holder');
    for (const slug of ['note-a', 'note-b', 'note-c']) {
      insertNode(connection.db, {
        type: 'resource',
        parentId: project.id,
        parentType: 'project',
        slug,
      });
    }
    make(connection, 'area', { id: work }, 'Visible area');

    const immediate = expectRight(list(connection, { parent: { id: work }, limit: 2 }));
    assert.deepEqual(slugsOf(immediate), ['holder', 'visible-area']);
    assert.equal(
      immediate.hasMore,
      false,
      'the restriction is applied in SQL before LIMIT, so hasMore describes rows the caller can receive',
    );

    const recursive = expectRight(list(connection, { parent: { id: work }, recursive: true }));
    assert.deepEqual(slugsOf(recursive), ['holder', 'visible-area']);
  });
});

test('a project lists nothing at all in this release, successfully', () => {
  withMigrated('list-empty-project', (connection) => {
    const project = make(connection, 'project', { path: '/work' }, 'Holder');
    insertNode(connection.db, {
      type: 'resource',
      parentId: project.id,
      parentType: 'project',
      slug: 'note',
    });

    const response = expectRight(list(connection, { parent: { id: project.id } }));
    assert.deepEqual(response.items, []);
    assert.equal(response.hasMore, false);
    assert.equal(
      response.skip,
      0,
      'a project may only contain resources, so an empty page here is a successful answer',
    );
  });
});

test('a scope this release cannot represent is refused rather than listed as empty', () => {
  withMigrated('list-resource-scope', (connection) => {
    const project = make(connection, 'project', { path: '/work' }, 'Holder');
    insertNode(connection.db, {
      type: 'resource',
      parentId: project.id,
      parentType: 'project',
      slug: 'note',
    });
    const resource = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE slug = ?',
      'note',
    ).id;

    const error = toPublicError(expectLeft(list(connection, { parent: { id: resource } })));
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, {
      field: 'parent',
      reason: 'unsupported_node_type',
      nodeType: 'resource',
    });
  });
});

test('a missing or malformed scope is distinguished from an empty one', () => {
  withMigrated('list-bad-scope', (connection) => {
    const missing = toPublicError(expectLeft(list(connection, { parent: { id: 777_777 } })));
    assert.equal(missing.code, 'node_not_found');
    assert.deepEqual(missing.details, { field: 'parent' });

    const malformed = toPublicError(expectLeft(list(connection, { parent: { path: 'work' } })));
    assert.equal(malformed.code, 'invalid_input');

    const emptyFilter = toPublicError(
      expectLeft(list(connection, { parent: { path: '/' }, types: [] })),
    );
    assert.equal(
      emptyFilter.code,
      'invalid_input',
      'asking for nothing must not be readable as an empty hierarchy',
    );
  });
});
