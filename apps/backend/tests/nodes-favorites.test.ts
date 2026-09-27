import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addFavorite,
  archiveNode,
  createNode,
  getNode,
  listFavorites,
  listNodes,
  moveNode,
  removeFavorite,
  restoreNode,
  searchNodes,
  toPublicError,
  updateNode,
} from '../src/modules/nodes/index.ts';
import { clockAt, expectLeft, expectRight, many, one, runNodes, withMigrated } from './support.ts';

/**
 * Favorites: a side table of node ids, written only by add and remove, read by every node response as
 * `isFavorite` and listed as ordinary summary pages.
 *
 * Every mutation is also checked for what it did *not* write: the target's revision and `updated_at`.
 */

type Connection = Parameters<typeof runNodes>[0];

const T0 = 1_700_000_000_000;
const AT = T0 + 5_000;
const WORK = 1;

const add = (connection: Connection, request: unknown) =>
  runNodes(connection, addFavorite(request));
const remove = (connection: Connection, request: unknown) =>
  runNodes(connection, removeFavorite(request));
const list = (connection: Connection, request: unknown = {}) =>
  expectRight(runNodes(connection, listFavorites(request)));

const create = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;
const area = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'area', parent, title });
const project = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'project', parent, title });
const note = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'resource', kind: 'note', parent, title });

const get = (connection: Connection, id: number) =>
  expectRight(runNodes(connection, getNode({ target: { id } }))).entity;

const favorited = (connection: Connection, id: number) =>
  expectRight(add(connection, { target: { id } }));

interface Row {
  readonly revision: number;
  readonly updatedAt: number;
}

const row = (connection: Connection, id: number): Row =>
  one<Row>(connection.db, 'SELECT revision, updated_at AS updatedAt FROM nodes WHERE id = ?', id);

const favoriteRows = (connection: Connection) =>
  many<{ nodeId: number }>(
    connection.db,
    'SELECT node_id AS nodeId FROM favorites ORDER BY node_id',
  ).map((favorite) => favorite.nodeId);

const archived = (connection: Connection, id: number) =>
  expectRight(
    runNodes(
      connection,
      archiveNode({ target: { id }, revision: row(connection, id).revision }),
      clockAt(AT),
    ),
  );
const restored = (connection: Connection, id: number) =>
  expectRight(
    runNodes(
      connection,
      restoreNode({ target: { id }, revision: row(connection, id).revision }),
      clockAt(AT),
    ),
  );

const listedIds = (connection: Connection, request: unknown = {}) =>
  list(connection, request).items.map((item) => item.id);

test('add by id or by path answers the resulting state, and a repeat leaves one row', () => {
  withMigrated('favorites-add', (connection) => {
    const garden = area(connection, { id: WORK }, 'Garden');
    const launch = project(connection, { id: garden.id }, 'Launch');

    assert.deepEqual(expectRight(add(connection, { target: { id: garden.id } })), {
      nodeId: garden.id,
      isFavorite: true,
    });
    assert.deepEqual(expectRight(add(connection, { target: { path: '/work/garden/launch' } })), {
      nodeId: launch.id,
      isFavorite: true,
    });
    assert.deepEqual(expectRight(add(connection, { target: { id: garden.id } })), {
      nodeId: garden.id,
      isFavorite: true,
    });
    assert.deepEqual(favoriteRows(connection), [garden.id, launch.id]);
  });
});

test('remove ensures absence: repeating it, or naming an id that is nothing, succeeds', () => {
  withMigrated('favorites-remove', (connection) => {
    const garden = area(connection, { id: WORK }, 'Garden');
    favorited(connection, garden.id);

    assert.deepEqual(expectRight(remove(connection, { target: { path: '/work/garden' } })), {
      nodeId: garden.id,
      isFavorite: false,
    });
    assert.deepEqual(expectRight(remove(connection, { target: { id: garden.id } })), {
      nodeId: garden.id,
      isFavorite: false,
    });
    assert.deepEqual(expectRight(remove(connection, { target: { id: 999_999 } })), {
      nodeId: 999_999,
      isFavorite: false,
    });
    assert.deepEqual(favoriteRows(connection), []);
  });
});

test('a selector that names nothing is node_not_found, except remove by id', () => {
  withMigrated('favorites-missing', (connection) => {
    for (const error of [
      expectLeft(add(connection, { target: { id: 999_999 } })),
      expectLeft(add(connection, { target: { path: '/work/nowhere' } })),
      expectLeft(remove(connection, { target: { path: '/work/nowhere' } })),
    ].map(toPublicError)) {
      assert.equal(error.code, 'node_not_found');
      assert.deepEqual(error.details, { field: 'target' });
    }
    assert.deepEqual(favoriteRows(connection), []);
  });
});

test('the root and malformed requests are invalid_input on the field at fault', () => {
  withMigrated('favorites-invalid', (connection) => {
    for (const request of [
      { target: { path: '/' } },
      { target: { id: 0 } },
      { target: { id: WORK, path: '/work' } },
    ]) {
      for (const error of [
        expectLeft(add(connection, request)),
        expectLeft(remove(connection, request)),
      ].map(toPublicError)) {
        assert.equal(error.code, 'invalid_input', JSON.stringify(request));
        assert.equal(error.details['field'], 'target', JSON.stringify(request));
      }
    }
    // A revision is not part of this request, so strict decoding refuses it.
    assert.equal(
      toPublicError(expectLeft(add(connection, { target: { id: WORK }, revision: 1 }))).code,
      'invalid_input',
    );

    for (const window of [{ limit: 0 }, { limit: 501 }, { skip: -1 }, { limit: 1.5 }]) {
      const error = toPublicError(expectLeft(runNodes(connection, listFavorites(window))));
      assert.equal(error.code, 'invalid_input', JSON.stringify(window));
      assert.equal(error.details['field'], Object.keys(window)[0], JSON.stringify(window));
    }
  });
});

test('a note is refused with a reason on target, and nothing is written; removing one succeeds', () => {
  withMigrated('favorites-note', (connection) => {
    const launch = project(connection, { id: WORK }, 'Launch');
    const runbook = note(connection, { id: launch.id }, 'Runbook');

    const error = toPublicError(expectLeft(add(connection, { target: { id: runbook.id } })));
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, 'Favorites hold areas and projects.');
    assert.deepEqual(error.details, { field: 'target', reason: 'favorite_requires_container' });
    assert.deepEqual(favoriteRows(connection), []);

    assert.deepEqual(expectRight(remove(connection, { target: { id: runbook.id } })), {
      nodeId: runbook.id,
      isFavorite: false,
    });
    assert.equal(get(connection, runbook.id).isFavorite, false);
  });
});

test('neither add nor remove changes a revision or updated_at', () => {
  withMigrated('favorites-revision', (connection) => {
    const garden = area(connection, { id: WORK }, 'Garden');
    const before = row(connection, garden.id);

    favorited(connection, garden.id);
    assert.deepEqual(row(connection, garden.id), before);
    favorited(connection, garden.id);
    assert.deepEqual(row(connection, garden.id), before);
    expectRight(remove(connection, { target: { id: garden.id } }));
    assert.deepEqual(row(connection, garden.id), before);
    assert.equal(get(connection, garden.id).revision, before.revision);
  });
});

test('something archived, directly or through a container, can still be added and removed', () => {
  withMigrated('favorites-archived-target', (connection) => {
    const shelf = area(connection, { id: WORK }, 'Shelf');
    const inner = project(connection, { id: shelf.id }, 'Inner');
    archived(connection, shelf.id);

    for (const id of [shelf.id, inner.id]) {
      assert.deepEqual(expectRight(add(connection, { target: { id } })), {
        nodeId: id,
        isFavorite: true,
      });
      assert.equal(get(connection, id).isFavorite, true);
    }
    assert.deepEqual(favoriteRows(connection), [shelf.id, inner.id]);
    for (const id of [shelf.id, inner.id]) {
      expectRight(remove(connection, { target: { id } }));
    }
    assert.deepEqual(favoriteRows(connection), []);
  });
});

test('the list is ordered by title without regard to ASCII case, then by id', () => {
  withMigrated('favorites-order', (connection) => {
    const cherry = area(connection, { id: WORK }, 'cherry');
    const banana = project(connection, { id: WORK }, 'Banana');
    const apple = area(connection, { id: WORK }, 'apple');
    const twinA = project(connection, { id: WORK }, 'Twin');
    const twinB = area(connection, { id: cherry.id }, 'Twin');
    // Added out of order, so the answer cannot be insertion order.
    for (const node of [twinB, cherry, twinA, apple, banana]) favorited(connection, node.id);

    const page = list(connection);
    assert.deepEqual(
      page.items.map((item) => item.id),
      [apple.id, banana.id, cherry.id, twinA.id, twinB.id],
    );
    assert.equal(
      page.items.every((item) => item.isFavorite),
      true,
    );
    assert.equal(
      page.items.every((item) => !item.archived),
      true,
    );
    assert.deepEqual([page.skip, page.limit, page.hasMore], [0, 50, false]);
  });
});

test('the page window cuts after ordering, and hasMore is observed', () => {
  withMigrated('favorites-window', (connection) => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((title) => {
      const node = area(connection, { id: WORK }, title);
      favorited(connection, node.id);
      return node.id;
    });

    const first = list(connection, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.id),
      ids.slice(0, 2),
    );
    assert.equal(first.hasMore, true);

    const middle = list(connection, { skip: 2, limit: 2 });
    assert.deepEqual(
      middle.items.map((item) => item.id),
      ids.slice(2, 4),
    );
    assert.equal(middle.hasMore, true);

    const last = list(connection, { skip: 4, limit: 2 });
    assert.deepEqual(
      last.items.map((item) => item.id),
      ids.slice(4),
    );
    assert.equal(last.hasMore, false);

    const exact = list(connection, { limit: 5 });
    assert.equal(exact.items.length, 5);
    assert.equal(exact.hasMore, false, 'a page that ends exactly at the last row has no more');

    const beyond = list(connection, { skip: 10 });
    assert.deepEqual([beyond.items, beyond.hasMore], [[], false]);
  });
});

test('archived favorites are hidden, directly or through ancestry, and stay favorites', () => {
  withMigrated('favorites-hidden', (connection) => {
    const shelf = area(connection, { id: WORK }, 'Shelf');
    const inner = project(connection, { id: shelf.id }, 'Inner');
    const own = project(connection, { id: shelf.id }, 'Own');
    const visible = area(connection, { id: WORK }, 'Visible');
    for (const node of [shelf, inner, own, visible]) favorited(connection, node.id);

    archived(connection, own.id);
    archived(connection, shelf.id);
    assert.deepEqual(listedIds(connection), [visible.id]);
    assert.equal(get(connection, inner.id).isFavorite, true, 'hidden, not removed');

    // Restoring the ancestor brings back what it alone was hiding; a node with its own cause stays out.
    restored(connection, shelf.id);
    assert.deepEqual(listedIds(connection), [inner.id, shelf.id, visible.id]);

    restored(connection, own.id);
    assert.deepEqual(listedIds(connection), [inner.id, own.id, shelf.id, visible.id]);
  });
});

test('a rename or a move keeps the favorite, and the list reads the current title', () => {
  withMigrated('favorites-follow', (connection) => {
    const garden = area(connection, { id: WORK }, 'Garden');
    const zebra = area(connection, { id: WORK }, 'Zebra');
    favorited(connection, garden.id);
    favorited(connection, zebra.id);

    const renamed = expectRight(
      runNodes(
        connection,
        updateNode({ target: { id: garden.id }, revision: 1, title: 'Zoo' }),
        clockAt(AT),
      ),
    ).entity;
    assert.equal(renamed.isFavorite, true);
    assert.deepEqual(
      list(connection).items.map((item) => item.title),
      ['Zebra', 'Zoo'],
    );

    const moved = expectRight(
      runNodes(
        connection,
        moveNode({
          target: { id: zebra.id },
          revision: 1,
          destination: { path: '/personal/zebra' },
        }),
        clockAt(AT),
      ),
    ).node;
    assert.equal(moved.isFavorite, true);
    assert.deepEqual(listedIds(connection), [zebra.id, garden.id]);
  });
});

test('every node response says whether the node is a favorite', () => {
  withMigrated('favorites-everywhere', (connection) => {
    const garden = create(connection, {
      type: 'area',
      parent: { id: WORK },
      title: 'Favorite garden',
    });
    assert.equal(garden.isFavorite, false, 'a new node is never a favorite');
    const plain = area(connection, { id: WORK }, 'Plain garden');
    favorited(connection, garden.id);

    assert.equal(get(connection, garden.id).isFavorite, true);
    assert.equal(get(connection, plain.id).isFavorite, false);

    const listed = expectRight(runNodes(connection, listNodes({ scopes: [{ id: WORK }] }))).items;
    assert.equal(listed.find((item) => item.id === garden.id)?.isFavorite, true);
    assert.equal(listed.find((item) => item.id === plain.id)?.isFavorite, false);

    const found = expectRight(
      runNodes(
        connection,
        searchNodes({ scopes: [{ id: WORK }], queries: ['garden'] }),
        clockAt(AT),
      ),
    ).items;
    assert.equal(found.find((hit) => hit.node.id === garden.id)?.node.isFavorite, true);
    assert.equal(found.find((hit) => hit.node.id === plain.id)?.node.isFavorite, false);

    const updated = expectRight(
      runNodes(
        connection,
        updateNode({ target: { id: garden.id }, revision: 1, description: 'Kept' }),
        clockAt(AT),
      ),
    ).entity;
    assert.equal(updated.isFavorite, true);

    assert.equal(archived(connection, garden.id).node.isFavorite, true);
    assert.equal(restored(connection, garden.id).node.isFavorite, true);
    assert.equal(archived(connection, plain.id).node.isFavorite, false);

    const moved = expectRight(
      runNodes(
        connection,
        moveNode({
          target: { id: garden.id },
          revision: row(connection, garden.id).revision,
          destination: { path: '/personal/garden' },
        }),
        clockAt(AT),
      ),
    ).node;
    assert.equal(moved.isFavorite, true);
  });
});
