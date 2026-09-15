import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, getNodePath, toPublicError } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  expectLeft,
  expectRight,
  insertNode,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

const T0 = 1_700_000_000_000;

/** Builds `/work/alpha/beta/gamma` and returns the ids. Areas nest; the leaf is a project. */
const nest = (connection: Parameters<typeof runNodes>[0]) => {
  const alpha = expectRight(
    runNodes(
      connection,
      createNode({ type: 'area', parent: { path: '/work' }, title: 'Alpha' }),
      clockAt(T0),
    ),
  ).entity.id;
  const beta = expectRight(
    runNodes(
      connection,
      createNode({ type: 'area', parent: { id: alpha }, title: 'Beta' }),
      clockAt(T0),
    ),
  ).entity.id;
  const gamma = expectRight(
    runNodes(
      connection,
      createNode({ type: 'project', parent: { id: beta }, title: 'Gamma' }),
      clockAt(T0),
    ),
  ).entity.id;
  return { alpha, beta, gamma };
};

test('a path is computed from ancestor slugs, and round-trips as a selector', () => {
  withMigrated('path-basic', (connection) => {
    const { gamma } = nest(connection);

    const computed = expectRight(runNodes(connection, getNodePath({ target: { id: gamma } })));
    assert.deepEqual(computed, { id: gamma, path: '/work/alpha/beta/gamma' });

    // The computed address must be usable as an address, which is the point of computing it.
    const reread = expectRight(runNodes(connection, getNode({ target: { path: computed.path } })));
    assert.equal(reread.entity.id, gamma);

    const byPath = expectRight(
      runNodes(connection, getNodePath({ target: { path: '/work/alpha/beta/gamma' } })),
    );
    assert.deepEqual(byPath, computed, 'both selector forms compute the same address');
  });
});

test('a root area is one segment deep', () => {
  withMigrated('path-root-area', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    assert.deepEqual(expectRight(runNodes(connection, getNodePath({ target: { id: work } }))), {
      id: work,
      path: '/work',
    });
  });
});

test('the root itself has no path to compute', () => {
  withMigrated('path-root', (connection) => {
    const error = toPublicError(
      expectLeft(runNodes(connection, getNodePath({ target: { path: '/' } }))),
    );
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, { field: 'target', reason: 'invalid' });
  });
});

test('a resource path is an ordinary entity path', () => {
  withMigrated('path-resource', (connection) => {
    const { gamma } = nest(connection);
    insertNode(connection.db, {
      type: 'resource',
      parentId: gamma,
      parentType: 'project',
      slug: 'note',
    });
    const resource = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE slug = ?',
      'note',
    ).id;

    // Nothing about addressing is special-cased for a leaf: the ancestor walk is the same walk, and
    // the answer is a path that can be handed straight back as a selector.
    const byId = expectRight(runNodes(connection, getNodePath({ target: { id: resource } })));
    assert.equal(byId.id, resource);
    assert.match(byId.path, /\/note$/);

    const byPath = expectRight(runNodes(connection, getNodePath({ target: { path: byId.path } })));
    assert.equal(byPath.id, resource);
    assert.equal(byPath.path, byId.path);
  });
});

test('a missing target is not found', () => {
  withMigrated('path-missing', (connection) => {
    const error = toPublicError(
      expectLeft(runNodes(connection, getNodePath({ target: { id: 999_999 } }))),
    );
    assert.equal(error.code, 'node_not_found');
    assert.deepEqual(error.details, { field: 'target' });
  });
});

test('cyclic stored ancestry is detected exactly, without a depth cap', () => {
  withMigrated('path-cycle', (connection) => {
    // Areas are the only type that may nest, so an all-area chain is what a cycle can be built from.
    const first = expectRight(
      runNodes(
        connection,
        createNode({ type: 'area', parent: { path: '/work' }, title: 'One' }),
        clockAt(T0),
      ),
    ).entity.id;
    const second = expectRight(
      runNodes(
        connection,
        createNode({ type: 'area', parent: { id: first }, title: 'Two' }),
        clockAt(T0),
      ),
    ).entity.id;
    const third = expectRight(
      runNodes(
        connection,
        createNode({ type: 'area', parent: { id: second }, title: 'Three' }),
        clockAt(T0),
      ),
    ).entity.id;

    // Close the chain. Creation cannot produce this and the parent key is RESTRICT, so direct SQL is the
    // only way to reach it - and the identity trigger deliberately permits a parent change, so a future
    // move can be atomic, which is what makes the case reachable at all.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(third, 'area', first);

    for (const id of [first, second, third]) {
      const error = toPublicError(
        expectLeft(runNodes(connection, getNodePath({ target: { id } }))),
      );
      assert.equal(error.code, 'internal_error', `cycle reached through ${id}`);
      assert.deepEqual(error.details, {});
    }
  });
});

test('a two-node cycle is caught as readily as a longer one', () => {
  withMigrated('path-short-cycle', (connection) => {
    const outer = expectRight(
      runNodes(
        connection,
        createNode({ type: 'area', parent: { path: '/work' }, title: 'Outer' }),
        clockAt(T0),
      ),
    ).entity.id;
    const inner = expectRight(
      runNodes(
        connection,
        createNode({ type: 'area', parent: { id: outer }, title: 'Inner' }),
        clockAt(T0),
      ),
    ).entity.id;

    // The schema already forbids `parent_id = id`, so two nodes is the smallest cycle that exists.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(inner, 'area', outer);

    const error = toPublicError(
      expectLeft(runNodes(connection, getNodePath({ target: { id: inner } }))),
    );
    assert.equal(error.code, 'internal_error');
  });
});

test('an ancestor that does not exist is corruption, not a missing target', () => {
  withMigrated('path-missing-ancestor', (connection) => {
    const { beta } = nest(connection);

    // Foreign keys are what normally prevent this, so they have to be off to build the case.
    connection.db.pragma('foreign_keys = OFF');
    connection.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(888_888, beta);
    connection.db.pragma('foreign_keys = ON');

    const error = toPublicError(
      expectLeft(runNodes(connection, getNodePath({ target: { id: beta } }))),
    );
    assert.equal(
      error.code,
      'internal_error',
      'the target was found; its ancestry is what is broken, and that is ours to fix',
    );
  });
});
