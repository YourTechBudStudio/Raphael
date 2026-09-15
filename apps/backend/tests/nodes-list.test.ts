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

test('resources are listed alongside containers, and the type filter is what excludes them', () => {
  withMigrated('list-includes-resources', (connection) => {
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

    // The default filter is every type, so an immediate listing of this area now returns both of its
    // containers and a recursive one reaches the notes underneath. This is the behaviour change every
    // container consumer was narrowed for.
    const immediate = expectRight(list(connection, { parent: { id: work } }));
    assert.deepEqual(slugsOf(immediate), ['holder', 'visible-area']);

    const recursive = expectRight(list(connection, { parent: { id: work }, recursive: true }));
    assert.deepEqual(slugsOf(recursive), ['holder', 'note-a', 'note-b', 'note-c', 'visible-area']);

    // Asking for containers is now something a caller says rather than something they get by default.
    const containers = expectRight(
      list(connection, { parent: { id: work }, recursive: true, types: ['area', 'project'] }),
    );
    assert.deepEqual(slugsOf(containers), ['holder', 'visible-area']);

    // And asking for resources reaches them across the containers in between: traversal is never
    // pruned by the filter, so the notes are not hidden by their non-matching ancestor.
    const notes = expectRight(
      list(connection, { parent: { id: work }, recursive: true, types: ['resource'] }),
    );
    assert.deepEqual(slugsOf(notes), ['note-a', 'note-b', 'note-c']);

    // Filtering happens in SQL before LIMIT, so hasMore describes rows the caller can actually receive
    // rather than being an artifact of rows dropped after the page was cut.
    const firstPage = expectRight(
      list(connection, { parent: { id: work }, recursive: true, types: ['resource'], limit: 2 }),
    );
    assert.deepEqual(slugsOf(firstPage), ['note-a', 'note-b']);
    assert.equal(firstPage.hasMore, true);
  });
});

test('a project lists the resources it holds', () => {
  withMigrated('list-project-resources', (connection) => {
    const project = make(connection, 'project', { path: '/work' }, 'Holder');
    insertNode(connection.db, {
      type: 'resource',
      parentId: project.id,
      parentType: 'project',
      slug: 'note',
    });

    const response = expectRight(list(connection, { parent: { id: project.id } }));
    assert.deepEqual(slugsOf(response), ['note']);
    assert.equal(response.items[0]?.type, 'resource');
    assert.equal(response.items[0]?.kind, 'note');
    assert.equal(response.hasMore, false);
  });
});

test('listing a resource is a successful empty page, not a refusal', () => {
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

    // A resource holds nothing, and an empty page is the truthful answer for a valid scope. The
    // refusal this replaces described a type the API could not represent, which is no longer true.
    const response = expectRight(list(connection, { parent: { id: resource } }));
    assert.deepEqual(response.items, []);
    assert.equal(response.hasMore, false);
    assert.equal(response.skip, 0);

    const recursive = expectRight(list(connection, { parent: { id: resource }, recursive: true }));
    assert.deepEqual(recursive.items, []);
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

/* ------------------------------------------------------------------ explicit ordering */

/**
 * A fixture with deliberate ties.
 *
 * Two notes share a timestamp, and two share a slug under different parents, because those are the
 * cases where an ordering that is not total stops being reproducible - and where a page boundary can
 * move between two requests that asked the same question.
 */
const orderedFixture = (connection: Parameters<typeof runNodes>[0]) => {
  const work = one<{ id: number }>(
    connection.db,
    'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
    'work',
  ).id;
  const alpha = make(connection, 'project', { id: work }, 'Alpha');
  const beta = make(connection, 'project', { id: work }, 'Beta');

  const add = (parentId: number, slug: string, updatedAt: number): number => {
    insertNode(connection.db, {
      type: 'resource',
      parentId,
      parentType: 'project',
      slug,
      title: slug,
      updatedAt,
      createdAt: updatedAt,
    });
    return one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id = ? AND slug = ?',
      parentId,
      slug,
    ).id;
  };

  return {
    work,
    // `shared` exists under both projects: equal slugs that only an id can separate.
    oldest: add(alpha.id, 'aaa', T0 + 1_000),
    sharedAlpha: add(alpha.id, 'shared', T0 + 2_000),
    sharedBeta: add(beta.id, 'shared', T0 + 2_000),
    newest: add(beta.id, 'zzz', T0 + 3_000),
  };
};

test('omitted ordering is unchanged: binary slug ascending, then id', () => {
  withMigrated('order-default', (connection) => {
    orderedFixture(connection);
    const response = expectRight(
      list(connection, { parent: { path: '/work' }, recursive: true, types: ['resource'] }),
    );
    assert.deepEqual(slugsOf(response), ['aaa', 'shared', 'shared', 'zzz']);

    // The two equal slugs settle by id, which is the tiebreaker that makes the order total.
    const ids = response.items.map((item) => item.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
  });
});

test('each field orders in both directions', () => {
  withMigrated('order-fields', (connection) => {
    const fixture = orderedFixture(connection);
    const request = (orderBy: unknown) => ({
      parent: { path: '/work' },
      recursive: true,
      types: ['resource'],
      orderBy,
    });

    assert.deepEqual(
      slugsOf(expectRight(list(connection, request([{ field: 'slug', direction: 'desc' }])))),
      ['zzz', 'shared', 'shared', 'aaa'],
    );

    const byRecency = expectRight(
      list(connection, request([{ field: 'updatedAt', direction: 'desc' }])),
    );
    assert.equal(byRecency.items[0]?.id, fixture.newest);
    assert.equal(byRecency.items[3]?.id, fixture.oldest);

    const oldestFirst = expectRight(
      list(connection, request([{ field: 'updatedAt', direction: 'asc' }])),
    );
    assert.equal(oldestFirst.items[0]?.id, fixture.oldest);

    // An explicit id clause keeps its own direction and is not shadowed by an appended one.
    const byIdDesc = expectRight(list(connection, request([{ field: 'id', direction: 'desc' }])));
    const ids = byIdDesc.items.map((item) => item.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => b - a),
    );
  });
});

test('clause priority is the array order, and ties fall through to the next clause', () => {
  withMigrated('order-priority', (connection) => {
    const fixture = orderedFixture(connection);
    const ordered = expectRight(
      list(connection, {
        parent: { path: '/work' },
        recursive: true,
        types: ['resource'],
        orderBy: [
          { field: 'updatedAt', direction: 'desc' },
          { field: 'slug', direction: 'asc' },
        ],
      }),
    );

    // The two shared-timestamp rows sit together in the middle, separated by the appended id clause
    // because their slugs are equal too.
    assert.deepEqual(
      ordered.items.map((item) => item.id),
      [fixture.newest, fixture.sharedAlpha, fixture.sharedBeta, fixture.oldest],
    );

    // Reversing the clauses reverses the question, which is the whole point of priority order.
    const slugFirst = expectRight(
      list(connection, {
        parent: { path: '/work' },
        recursive: true,
        types: ['resource'],
        orderBy: [
          { field: 'slug', direction: 'asc' },
          { field: 'updatedAt', direction: 'desc' },
        ],
      }),
    );
    assert.deepEqual(slugsOf(slugFirst), ['aaa', 'shared', 'shared', 'zzz']);
  });
});

test('ordering is global across the scope, applied before the page is cut', () => {
  withMigrated('order-global-paging', (connection) => {
    const fixture = orderedFixture(connection);
    const page = (skip: number) =>
      expectRight(
        list(connection, {
          parent: { path: '/' },
          recursive: true,
          types: ['resource'],
          orderBy: [{ field: 'updatedAt', direction: 'desc' }],
          skip,
          limit: 2,
        }),
      );

    // Recursion from the root spans both projects and both areas. If ordering ran per branch, or
    // after the limit, the second page would not continue the first.
    const first = page(0);
    assert.deepEqual(
      first.items.map((item) => item.id),
      [fixture.newest, fixture.sharedAlpha],
    );
    assert.equal(first.hasMore, true);

    const second = page(2);
    assert.deepEqual(
      second.items.map((item) => item.id),
      [fixture.sharedBeta, fixture.oldest],
    );
    assert.equal(second.hasMore, false);
  });
});

test('ordering does not prune ancestors that the type filter excludes', () => {
  withMigrated('order-traversal', (connection) => {
    const fixture = orderedFixture(connection);
    const notes = expectRight(
      list(connection, {
        parent: { path: '/' },
        recursive: true,
        types: ['resource'],
        orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      }),
    );
    // Every note lives under a project, which the filter excludes. Pruning traversal by the filter
    // would return nothing at all.
    assert.equal(notes.items.length, 4);
    assert.equal(notes.items[0]?.id, fixture.newest);
  });
});

test('invalid ordering is refused with a bounded error that names the field and nothing else', () => {
  withMigrated('order-invalid', (connection) => {
    for (const orderBy of [
      [],
      'slug asc',
      [{ field: 'title', direction: 'asc' }],
      [{ field: 'slug', direction: 'sideways' }],
      [{ field: 'slug' }],
      [
        { field: 'slug', direction: 'asc' },
        { field: 'slug', direction: 'desc' },
      ],
      // Injection-shaped input is refused as ordinary invalid input: the vocabulary is closed and the
      // SQL is assembled from fixed fragments, so this never reaches a query to begin with.
      [{ field: 'slug; DROP TABLE nodes', direction: 'asc' }],
      [{ field: 'slug', direction: 'asc --' }],
    ]) {
      const error = toPublicError(expectLeft(list(connection, { parent: { path: '/' }, orderBy })));
      assert.equal(error.code, 'invalid_input', JSON.stringify(orderBy));
      assert.deepEqual(
        error.details,
        { field: 'orderBy', reason: 'invalid' },
        'never the submitted clause, and never a decoder string',
      );
    }

    // The table is still there, which is the part an injection test is actually about.
    assert.ok(
      expectRight(list(connection, { parent: { path: '/' } })).items.length > 0,
      'the refusals above changed nothing',
    );
  });
});

test('ordering by a timestamp does not put a timestamp in the response', () => {
  withMigrated('order-no-timestamps', (connection) => {
    orderedFixture(connection);
    const response = expectRight(
      list(connection, {
        parent: { path: '/' },
        recursive: true,
        orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      }),
    );
    for (const item of response.items) {
      const keys = Object.keys(item);
      assert.equal(keys.includes('updatedAt'), false);
      assert.equal(keys.includes('createdAt'), false);
    }
  });
});

test('reading and listing never advance a node updated_at', () => {
  withMigrated('order-recency-stable', (connection) => {
    orderedFixture(connection);
    const before = many<{ id: number; updatedAt: number }>(
      connection.db,
      'SELECT id, updated_at AS updatedAt FROM nodes ORDER BY id',
    );

    expectRight(
      list(connection, {
        parent: { path: '/' },
        recursive: true,
        orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      }),
    );

    const after = many<{ id: number; updatedAt: number }>(
      connection.db,
      'SELECT id, updated_at AS updatedAt FROM nodes ORDER BY id',
    );
    assert.deepEqual(after, before, 'a read is not an edit, so recency is not touched by browsing');
  });
});
