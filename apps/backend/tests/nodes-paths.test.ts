import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveNode,
  createNode as createNodeRaw,
  getNode,
  getNodePath,
  listNodes,
  moveNode,
  restoreNode,
  searchNodes,
} from '../src/modules/nodes/index.ts';
import {
  clockAt,
  expectLeft,
  expectRight,
  runNodes,
  withDerivedSlug,
  withMigrated,
} from './support.ts';

/**
 * Paths on request (ADR 0004). Every answer that describes an item carries its current path exactly
 * when the request asked for paths; nothing stores one. A page computes its paths in one statement and
 * a single item walks its chain, and the two must agree wherever an item can be: nested, moved,
 * archived, and on any page of a listing.
 */

type Connection = Parameters<typeof runNodes>[0];

const T0 = 1_700_000_000_000;
const WORK = 1;

const createNode = (request: unknown) => createNodeRaw(withDerivedSlug(request));
const create = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, createNode(request), clockAt(T0)));
const area = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'area', parent, title }).entity;
const project = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'project', parent, title }).entity;
const note = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'resource', kind: 'note', parent, title, body: { value: 'paths' } })
    .entity;

const list = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, listNodes(request)));
const pathOfId = (connection: Connection, id: number) =>
  expectRight(runNodes(connection, getNodePath({ target: { id } }))).path;

/** A small tree: /work/garden/launch/runbook, /work/garden/plans, /work/shed. */
const tree = (connection: Connection) => {
  const garden = area(connection, { id: WORK }, 'Garden');
  const launch = project(connection, { id: garden.id }, 'Launch');
  const runbook = note(connection, { id: launch.id }, 'Runbook');
  const plans = note(connection, { id: garden.id }, 'Plans');
  const shed = area(connection, { id: WORK }, 'Shed');
  return { garden, launch, runbook, plans, shed };
};

test('no answer carries a path unless the request asked for paths', () => {
  withMigrated('paths-opt-in', (connection) => {
    const { runbook } = tree(connection);

    const page = list(connection, { scopes: [{ path: '/' }], recursive: true });
    assert.equal(page.items.length > 0, true);
    assert.equal(
      page.items.some((item) => 'path' in item),
      false,
    );
    const hits = expectRight(
      runNodes(
        connection,
        searchNodes({ scopes: [{ path: '/' }], recursive: true, queries: ['paths'] }),
      ),
    );
    assert.equal(hits.items.length, 2);
    assert.equal(
      hits.items.some(({ node }) => 'path' in node),
      false,
    );
    const read = expectRight(runNodes(connection, getNode({ target: { id: runbook.id } })));
    assert.equal('path' in read.entity, false);
    assert.equal('path' in note(connection, { id: WORK }, 'Loose'), false);
  });
});

test('asked for, every item carries its current path, on every kind of answer', () => {
  withMigrated('paths-everywhere', (connection) => {
    const { garden, launch, runbook, plans, shed } = tree(connection);
    const expected = new Map([
      [WORK, '/work'],
      [garden.id, '/work/garden'],
      [launch.id, '/work/garden/launch'],
      [runbook.id, '/work/garden/launch/runbook'],
      [plans.id, '/work/garden/plans'],
      [shed.id, '/work/shed'],
    ]);

    const page = list(connection, { scopes: [{ path: '/' }], recursive: true, includePaths: true });
    for (const item of page.items) {
      assert.equal(item.path, pathOfId(connection, item.id), String(item.id));
      if (expected.has(item.id)) assert.equal(item.path, expected.get(item.id));
    }

    const hits = expectRight(
      runNodes(
        connection,
        searchNodes({
          scopes: [{ id: garden.id }],
          recursive: true,
          queries: ['paths'],
          includePaths: true,
        }),
      ),
    );
    assert.deepEqual(hits.items.map(({ node }) => node.path).sort(), [
      '/work/garden/launch/runbook',
      '/work/garden/plans',
    ]);

    const read = expectRight(
      runNodes(connection, getNode({ target: { id: runbook.id }, includePaths: true })),
    );
    assert.equal(read.entity.path, '/work/garden/launch/runbook');

    const created = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: launch.id },
      title: 'Checklist',
      includePaths: true,
    });
    assert.equal(created.entity.path, '/work/garden/launch/checklist');
    const top = create(connection, {
      type: 'area',
      parent: { path: '/' },
      title: 'Top',
      includePaths: true,
    });
    assert.equal(top.entity.path, '/top');
  });
});

test('paths follow a move, and the move says where the item was', () => {
  withMigrated('paths-move', (connection) => {
    const { garden, launch, runbook, shed } = tree(connection);

    const moved = expectRight(
      runNodes(
        connection,
        moveNode({
          target: { id: launch.id },
          revision: launch.revision,
          destination: { parent: { id: shed.id } },
          includePaths: true,
        }),
        clockAt(T0 + 1_000),
      ),
    );
    assert.equal(moved.changed, true);
    assert.equal(moved.previousPath, '/work/garden/launch');
    assert.equal(moved.node.path, '/work/shed/launch');
    assert.equal(moved.node.revision, launch.revision + 1);
    assert.equal(moved.node.updatedAt, new Date(T0 + 1_000).toISOString());

    // A descendant's path changed without its row being written.
    const page = list(connection, {
      scopes: [{ id: shed.id }],
      recursive: true,
      includePaths: true,
    });
    assert.deepEqual(
      page.items.map((item) => [item.id, item.path]),
      [
        [launch.id, '/work/shed/launch'],
        [runbook.id, '/work/shed/launch/runbook'],
      ],
    );
    assert.equal(pathOfId(connection, runbook.id), '/work/shed/launch/runbook');
    assert.equal(
      list(connection, { scopes: [{ id: garden.id }], recursive: true }).items.some(
        (item) => item.id === launch.id,
      ),
      false,
    );

    // Moving to where it already is changes nothing: same revision and time, both paths the same.
    const again = expectRight(
      runNodes(
        connection,
        moveNode({
          target: { id: launch.id },
          revision: moved.node.revision,
          destination: { parent: { id: shed.id } },
          includePaths: true,
        }),
        clockAt(T0 + 2_000),
      ),
    );
    assert.equal(again.changed, false);
    assert.equal(again.node.revision, moved.node.revision);
    assert.equal(again.node.updatedAt, moved.node.updatedAt);
    assert.equal(again.previousPath, again.node.path);

    const plain = expectRight(
      runNodes(
        connection,
        moveNode({
          target: { id: launch.id },
          revision: moved.node.revision,
          destination: { path: '/work/garden/launch' },
        }),
      ),
    );
    assert.equal('path' in plain.node, false);
    assert.equal('previousPath' in plain, false);
  });
});

test('archived items carry their paths, and archive and restore answer the target path', () => {
  withMigrated('paths-archived', (connection) => {
    const { garden, launch, runbook } = tree(connection);
    const archived = expectRight(
      runNodes(
        connection,
        archiveNode({ target: { id: garden.id }, revision: garden.revision, includePaths: true }),
        clockAt(T0 + 1_000),
      ),
    );
    assert.equal(archived.node.path, '/work/garden');
    assert.equal(archived.changed, true);

    const page = list(connection, {
      scopes: [{ id: WORK }],
      recursive: true,
      includeArchived: true,
      includePaths: true,
    });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    assert.equal(byId.get(runbook.id)?.archived, true);
    assert.equal(byId.get(runbook.id)?.path, '/work/garden/launch/runbook');

    const restoredInner = expectRight(
      runNodes(
        connection,
        restoreNode({ target: { id: launch.id }, revision: launch.revision, includePaths: true }),
      ),
    );
    assert.equal(restoredInner.changed, false, 'nothing of its own to remove');
    assert.equal(restoredInner.node.path, '/work/garden/launch');
    assert.equal(restoredInner.node.archived, true);
  });
});

test('every page of a listing agrees with the single-item path', () => {
  withMigrated('paths-pages', (connection) => {
    tree(connection);
    const all = list(connection, {
      scopes: [{ path: '/' }],
      recursive: true,
      includeArchived: true,
      includePaths: true,
      limit: 500,
    }).items;
    const seen: number[] = [];
    for (let skip = 0; skip < all.length; skip += 3) {
      const page = list(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        includeArchived: true,
        includePaths: true,
        skip,
        limit: 3,
      });
      for (const item of page.items) {
        seen.push(item.id);
        assert.equal(item.path, pathOfId(connection, item.id), String(item.id));
      }
    }
    assert.deepEqual(
      seen,
      all.map((item) => item.id),
    );
  });
});

test('corrupt ancestry is an integrity failure for a page path, not a wrong path', () => {
  withMigrated('paths-corrupt', (connection) => {
    const x = area(connection, { path: '/personal' }, 'X');
    const y = area(connection, { id: x.id }, 'Y');
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(y.id, 'area', x.id);

    // Without paths the listing still answers: nothing walks the cycle.
    expectRight(runNodes(connection, listNodes({ scopes: [{ id: x.id }] })));
    const failure = expectLeft(
      runNodes(connection, listNodes({ scopes: [{ id: x.id }], includePaths: true })),
    );
    assert.equal(failure._tag, 'InternalFailure');
  });
});

test('a listing says when archived items were left out, anywhere in the answer', () => {
  withMigrated('list-archived-left-out', (connection) => {
    const { garden, shed } = tree(connection);
    const scope = { scopes: [{ id: WORK }], recursive: true };
    assert.equal(list(connection, scope).archivedLeftOut, false);

    expectRight(
      runNodes(connection, archiveNode({ target: { id: shed.id }, revision: shed.revision })),
    );
    assert.equal(list(connection, scope).archivedLeftOut, true);
    // Beyond this window as well: the first page holds only active items.
    const first = list(connection, { ...scope, limit: 1 });
    assert.equal(
      first.items.every((item) => !item.archived),
      true,
    );
    assert.equal(first.archivedLeftOut, true);
    assert.equal(list(connection, { ...scope, includeArchived: true }).archivedLeftOut, false);
    // The filter applies to what was left out too: no archived project exists.
    assert.equal(
      list(connection, { ...scope, filter: { type: 'project' } }).archivedLeftOut,
      false,
    );
    // And the scopes: nothing archived is under the garden.
    assert.equal(
      list(connection, { scopes: [{ id: garden.id }], recursive: true }).archivedLeftOut,
      false,
    );
  });
});
