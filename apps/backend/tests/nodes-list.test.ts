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
    const response = expectRight(list(connection, { scopes: [{ path: '/' }] }));
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

    const response = expectRight(list(connection, { scopes: [{ id: work }] }));
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

    const first = expectRight(list(connection, { scopes: [{ id: work }], limit: 2 }));
    assert.deepEqual(slugsOf(first), ['five', 'four']);
    assert.equal(first.hasMore, true);
    assert.equal(first.limit, 2);

    const second = expectRight(list(connection, { scopes: [{ id: work }], limit: 2, skip: 2 }));
    assert.deepEqual(slugsOf(second), ['one', 'three']);
    assert.equal(second.hasMore, true);

    const third = expectRight(list(connection, { scopes: [{ id: work }], limit: 2, skip: 4 }));
    assert.deepEqual(slugsOf(third), ['two']);
    assert.equal(third.hasMore, false, 'the last page says so without a second query to check');
    assert.equal(third.skip, 4);

    const past = expectRight(list(connection, { scopes: [{ id: work }], limit: 2, skip: 99 }));
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
      list(connection, { scopes: [{ id: work }], recursive: true, filter: { type: 'project' } }),
    );
    assert.deepEqual(
      slugsOf(projectsOnly),
      ['buried-project', 'shallow-project'],
      'the walk must pass through areas to reach a project that is not a direct child',
    );

    const areasOnly = expectRight(
      list(connection, { scopes: [{ id: work }], recursive: true, filter: { type: 'area' } }),
    );
    assert.deepEqual(slugsOf(areasOnly), ['inner', 'outer']);

    const immediate = expectRight(
      list(connection, { scopes: [{ id: work }], filter: { type: 'project' } }),
    );
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

    const response = expectRight(list(connection, { scopes: [{ id: work }], recursive: true }));
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

    const response = expectRight(list(connection, { scopes: [{ path: '/' }], recursive: true }));
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

    const before = expectRight(list(connection, { scopes: [{ id: work }], recursive: true }));
    assert.deepEqual(slugsOf(before), ['child']);

    // Close a cycle so the scope becomes reachable from its own descendants.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(child.id, 'area', work);

    const after = expectRight(list(connection, { scopes: [{ id: work }], recursive: true }));
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
    const immediate = expectRight(list(connection, { scopes: [{ id: work }] }));
    assert.deepEqual(slugsOf(immediate), ['holder', 'visible-area']);

    const recursive = expectRight(list(connection, { scopes: [{ id: work }], recursive: true }));
    assert.deepEqual(slugsOf(recursive), ['holder', 'note-a', 'note-b', 'note-c', 'visible-area']);

    // Asking for containers is now something a caller says rather than something they get by default.
    const containers = expectRight(
      list(connection, {
        scopes: [{ id: work }],
        recursive: true,
        filter: { type: { $in: ['area', 'project'] } },
      }),
    );
    assert.deepEqual(slugsOf(containers), ['holder', 'visible-area']);

    // And asking for resources reaches them across the containers in between: traversal is never
    // pruned by the filter, so the notes are not hidden by their non-matching ancestor.
    const notes = expectRight(
      list(connection, { scopes: [{ id: work }], recursive: true, filter: { type: 'resource' } }),
    );
    assert.deepEqual(slugsOf(notes), ['note-a', 'note-b', 'note-c']);

    // Filtering happens in SQL before LIMIT, so hasMore describes rows the caller can actually receive
    // rather than being an artifact of rows dropped after the page was cut.
    const firstPage = expectRight(
      list(connection, {
        scopes: [{ id: work }],
        recursive: true,
        filter: { type: 'resource' },
        limit: 2,
      }),
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

    const response = expectRight(list(connection, { scopes: [{ id: project.id }] }));
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
    const response = expectRight(list(connection, { scopes: [{ id: resource }] }));
    assert.deepEqual(response.items, []);
    assert.equal(response.hasMore, false);
    assert.equal(response.skip, 0);

    const recursive = expectRight(
      list(connection, { scopes: [{ id: resource }], recursive: true }),
    );
    assert.deepEqual(recursive.items, []);
  });
});

test('a missing or malformed scope is distinguished from an empty one', () => {
  withMigrated('list-bad-scope', (connection) => {
    const missing = toPublicError(expectLeft(list(connection, { scopes: [{ id: 777_777 }] })));
    assert.equal(missing.code, 'node_not_found');
    // The field is `scopes` now, and it names the position in the caller's own list.
    assert.deepEqual(missing.details, { field: 'scopes', index: 0 });

    const malformed = toPublicError(expectLeft(list(connection, { scopes: [{ path: 'work' }] })));
    assert.equal(malformed.code, 'invalid_input');

    const emptyFilter = toPublicError(
      expectLeft(list(connection, { scopes: [{ path: '/' }], filter: { type: { $in: [] } } })),
    );
    assert.equal(
      emptyFilter.code,
      'invalid_input',
      'asking for nothing must not be readable as an empty hierarchy',
    );

    // A scope that does not resolve refuses the whole request, even beside one that does, and says
    // which one it was.
    const second = toPublicError(
      expectLeft(list(connection, { scopes: [{ path: '/' }, { id: 777_777 }] })),
    );
    assert.equal(second.code, 'node_not_found');
    assert.deepEqual(second.details, { field: 'scopes', index: 1 });
  });
});

test('several scopes are one union, and an overlap does not duplicate a row', () => {
  withMigrated('list-scope-union', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    const raphael = make(connection, 'project', { id: work }, 'Raphael');
    make(connection, 'project', { id: work }, 'Isagi');
    make(connection, 'area', { id: work }, 'Notes area');

    // `/work` and one of its own children, searched together. The child is still a result of its
    // parent's scope, and nothing appears twice.
    const nonRecursive = expectRight(
      list(connection, { scopes: [{ id: work }, { id: raphael.id }] }),
    );
    assert.deepEqual(slugsOf(nonRecursive), ['isagi', 'notes-area', 'raphael']);

    const recursive = expectRight(
      list(connection, { scopes: [{ id: work }, { id: raphael.id }], recursive: true }),
    );
    assert.deepEqual(slugsOf(recursive), ['isagi', 'notes-area', 'raphael']);

    // Two spellings of one node are accepted by the contract and deduplicated here.
    const spellings = expectRight(list(connection, { scopes: [{ id: work }, { path: '/work' }] }));
    assert.deepEqual(slugsOf(spellings), slugsOf(nonRecursive));
  });
});

test('the shared predicate filters by kind and by tag, not only by type', () => {
  withMigrated('list-shared-predicate', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    expectRight(
      runNodes(
        connection,
        createNode({
          type: 'resource',
          kind: 'note',
          parent: { id: work },
          title: 'Tagged note',
          tags: ['backend', 'auth'],
        }),
        clockAt(T0),
      ),
    );
    expectRight(
      runNodes(
        connection,
        createNode({
          type: 'resource',
          kind: 'note',
          parent: { id: work },
          title: 'Plain note',
        }),
        clockAt(T0),
      ),
    );
    make(connection, 'project', { id: work }, 'A project');

    const notes = expectRight(
      list(connection, { scopes: [{ id: work }], filter: { kind: 'note' } }),
    );
    assert.deepEqual(slugsOf(notes), ['plain-note', 'tagged-note']);

    // A kind predicate does not have to imply a type one: a container's kind is NULL and simply does
    // not match.
    assert.ok(!slugsOf(notes).includes('a-project'));

    const tagged = expectRight(
      list(connection, { scopes: [{ id: work }], filter: { tags: 'backend' } }),
    );
    assert.deepEqual(slugsOf(tagged), ['tagged-note']);

    // Compared after normalization, and case-sensitively.
    const padded = expectRight(
      list(connection, { scopes: [{ id: work }], filter: { tags: { $in: [' backend '] } } }),
    );
    assert.deepEqual(slugsOf(padded), ['tagged-note']);
    const wrongCase = expectRight(
      list(connection, { scopes: [{ id: work }], filter: { tags: 'Backend' } }),
    );
    assert.deepEqual(slugsOf(wrongCase), []);

    // Siblings are ANDed.
    const both = expectRight(
      list(connection, {
        scopes: [{ id: work }],
        filter: { type: 'resource', tags: { $in: ['auth', 'finance'] } },
      }),
    );
    assert.deepEqual(slugsOf(both), ['tagged-note']);
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
      list(connection, {
        scopes: [{ path: '/work' }],
        recursive: true,
        filter: { type: 'resource' },
      }),
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
      scopes: [{ path: '/work' }],
      recursive: true,
      filter: { type: 'resource' },
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
        scopes: [{ path: '/work' }],
        recursive: true,
        filter: { type: 'resource' },
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
        scopes: [{ path: '/work' }],
        recursive: true,
        filter: { type: 'resource' },
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
          scopes: [{ path: '/' }],
          recursive: true,
          filter: { type: 'resource' },
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
        scopes: [{ path: '/' }],
        recursive: true,
        filter: { type: 'resource' },
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
      const error = toPublicError(
        expectLeft(list(connection, { scopes: [{ path: '/' }], orderBy })),
      );
      assert.equal(error.code, 'invalid_input', JSON.stringify(orderBy));
      assert.deepEqual(
        error.details,
        { field: 'orderBy', reason: 'invalid' },
        'never the submitted clause, and never a decoder string',
      );
    }

    // The table is still there, which is the part an injection test is actually about.
    assert.ok(
      expectRight(list(connection, { scopes: [{ path: '/' }] })).items.length > 0,
      'the refusals above changed nothing',
    );
  });
});

test('ordering by a timestamp does not put a timestamp in the response', () => {
  withMigrated('order-no-timestamps', (connection) => {
    orderedFixture(connection);
    const response = expectRight(
      list(connection, {
        scopes: [{ path: '/' }],
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
        scopes: [{ path: '/' }],
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

test('a listing says which projects are selected, and every other row says it is not', () => {
  withMigrated('list-active', (connection) => {
    const work = one<{ id: number }>(connection.db, `SELECT id FROM nodes WHERE slug = 'work'`).id;
    insertNode(connection.db, {
      type: 'project',
      parentId: work,
      parentType: 'area',
      slug: 'selected',
      active: 1,
    });
    insertNode(connection.db, {
      type: 'project',
      parentId: work,
      parentType: 'area',
      slug: 'unselected',
    });
    insertNode(connection.db, {
      type: 'area',
      parentId: work,
      parentType: 'area',
      slug: 'reading',
    });

    // `active` is on the summary, not only on the entity, because Home discovers the selection from
    // the one traversal it already performs rather than from a second read that could disagree.
    for (const recursive of [false, true]) {
      const response = expectRight(list(connection, { scopes: [{ id: work }], recursive }));
      assert.deepEqual(Object.fromEntries(response.items.map((item) => [item.slug, item.active])), {
        selected: true,
        unselected: false,
        reading: false,
      });
    }
  });
});

/**
 * A small archived fixture:
 *
 * ```text
 * /work (active)                  /personal (cause)
 *   shelf (area, cause)             trip (project)
 *     apollo (project)                itinerary (note)
 *       plan (note)
 *   live (project)
 *     draft (note)
 *     hidden (note, cause)
 * ```
 */
const archivedFixture = (connection: Parameters<typeof runNodes>[0]) => {
  const create = (request: Record<string, unknown>) =>
    expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;
  const shelf = create({ type: 'area', parent: { path: '/work' }, title: 'Shelf' });
  const apollo = create({ type: 'project', parent: { id: shelf.id }, title: 'Apollo' });
  const plan = create({ type: 'resource', kind: 'note', parent: { id: apollo.id }, title: 'Plan' });
  const live = create({ type: 'project', parent: { path: '/work' }, title: 'Live' });
  const draft = create({ type: 'resource', kind: 'note', parent: { id: live.id }, title: 'Draft' });
  const hidden = create({
    type: 'resource',
    kind: 'note',
    parent: { id: live.id },
    title: 'Hidden',
  });
  const trip = create({ type: 'project', parent: { path: '/personal' }, title: 'Trip' });
  const itinerary = create({
    type: 'resource',
    kind: 'note',
    parent: { id: trip.id },
    title: 'Itinerary',
  });
  const personal = one<{ id: number }>(
    connection.db,
    `SELECT id FROM nodes WHERE parent_id IS NULL AND slug = 'personal'`,
  ).id;
  const cause = connection.db.prepare(
    `INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, 'user', 'direct', ?)`,
  );
  for (const id of [shelf.id, hidden.id, personal]) cause.run(id, T0);
  return { shelf, apollo, plan, live, draft, hidden, trip, itinerary, personal };
};

const idsOf = (response: { items: readonly { id: number }[] }) =>
  response.items.map((item) => item.id).sort((a, b) => a - b);

test('an active root area and everything active under it stay listed while another container is archived', () => {
  withMigrated('list-archived-root-guard', (connection) => {
    const f = archivedFixture(connection);
    const work = 1;

    // Shape 2: the root's children. The active root area is there; the archived one is not.
    const top = expectRight(list(connection, { scopes: [{ path: '/' }] }));
    assert.deepEqual(slugsOf(top), ['work']);
    assert.equal(top.items[0]?.id, work);

    // Shape 1: everything under the root. Every active node, and nothing archived.
    const everything = expectRight(list(connection, { scopes: [{ path: '/' }], recursive: true }));
    assert.deepEqual(
      idsOf(everything),
      [work, f.live.id, f.draft.id].sort((a, b) => a - b),
    );
    assert.ok(everything.items.every((item) => !item.archived));
  });
});

test('default exclusion holds in every membership shape, and inclusion marks exactly the archived', () => {
  withMigrated('list-archived-shapes', (connection) => {
    const f = archivedFixture(connection);

    // Shape 2 with a node scope: a directly archived note in an active project is hidden.
    const children = expectRight(list(connection, { scopes: [{ id: f.live.id }] }));
    assert.deepEqual(idsOf(children), [f.draft.id]);

    // Shape 3: a recursive walk from a node scope.
    const work = expectRight(list(connection, { scopes: [{ path: '/work' }], recursive: true }));
    assert.deepEqual(
      idsOf(work),
      [f.live.id, f.draft.id].sort((a, b) => a - b),
    );

    const included = expectRight(
      list(connection, { scopes: [{ path: '/work' }], recursive: true, includeArchived: true }),
    );
    const marked = Object.fromEntries(included.items.map((item) => [item.id, item.archived]));
    assert.deepEqual(marked, {
      [f.shelf.id]: true,
      [f.apollo.id]: true,
      [f.plan.id]: true,
      [f.live.id]: false,
      [f.draft.id]: false,
      [f.hidden.id]: true,
    });

    const everything = expectRight(
      list(connection, { scopes: [{ path: '/' }], recursive: true, includeArchived: true }),
    );
    assert.equal(everything.items.find((item) => item.id === f.personal)?.archived, true);
    assert.equal(everything.items.find((item) => item.id === f.itinerary.id)?.archived, true);
    assert.equal(everything.items.find((item) => item.id === 1)?.archived, false);
  });
});

test('a scope inside an archived subtree is an empty page by default and a marked one on request', () => {
  withMigrated('list-archived-inside', (connection) => {
    const f = archivedFixture(connection);

    for (const recursive of [false, true]) {
      const empty = expectRight(list(connection, { scopes: [{ id: f.apollo.id }], recursive }));
      assert.deepEqual(empty.items, [], `recursive: ${recursive}`);

      const shown = expectRight(
        list(connection, { scopes: [{ id: f.apollo.id }], recursive, includeArchived: true }),
      );
      assert.deepEqual(idsOf(shown), [f.plan.id]);
      assert.equal(shown.items[0]?.archived, true);
    }
  });
});

test('paging and hasMore hold under exclusion', () => {
  withMigrated('list-archived-paging', (connection) => {
    const work = 1;
    const titles = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const made = titles.map((title) => make(connection, 'project', { id: work }, title));
    const cause = connection.db.prepare(
      `INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, 'user', 'direct', ?)`,
    );
    for (const index of [1, 3]) cause.run(made[index]?.id, T0);

    const first = expectRight(list(connection, { scopes: [{ id: work }], limit: 2 }));
    assert.deepEqual(slugsOf(first), ['a1', 'a3']);
    assert.equal(first.hasMore, true);
    const second = expectRight(list(connection, { scopes: [{ id: work }], skip: 2, limit: 2 }));
    assert.deepEqual(slugsOf(second), ['a5', 'a6']);
    assert.equal(second.hasMore, false);

    const included = expectRight(
      list(connection, { scopes: [{ id: work }], limit: 2, skip: 4, includeArchived: true }),
    );
    assert.deepEqual(slugsOf(included), ['a5', 'a6']);
    assert.equal(included.hasMore, false);
  });
});
