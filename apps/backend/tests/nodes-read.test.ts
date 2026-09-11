import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, toPublicError } from '../src/modules/nodes/index.ts';
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

const seed = (connection: Parameters<typeof runNodes>[0]) =>
  expectRight(
    runNodes(
      connection,
      createNode({
        type: 'project',
        parent: { path: '/work' },
        title: 'Quarterly plan',
        description: 'The plan',
        tags: ['planning', 'Q3'],
        metadata: { owner: 'me', nested: { depth: 2 } },
        body: { value: '# Goals\n\n- one\n- two' },
      }),
      clockAt(T0),
    ),
  ).entity;

test('an id and its path resolve to the same entity', () => {
  withMigrated('read-parity', (connection) => {
    const created = seed(connection);

    const byId = expectRight(runNodes(connection, getNode({ target: { id: created.id } })));
    const byPath = expectRight(
      runNodes(connection, getNode({ target: { path: '/work/quarterly-plan' } })),
    );

    assert.deepEqual(byId, byPath, 'one resolution path, two ways of naming the same node');
    assert.deepEqual(byId.entity.tags, ['planning', 'Q3']);
    assert.deepEqual(byId.entity.metadata, { owner: 'me', nested: { depth: 2 } });
    assert.equal(byId.entity.description, 'The plan');
    assert.deepEqual(byId.entity.body, { format: 'markdown', value: '# Goals\n\n- one\n- two' });
  });
});

test('the body comes back in the requested format and never carries a path', () => {
  withMigrated('read-format', (connection) => {
    const created = seed(connection);

    const asTipTap = expectRight(
      runNodes(connection, getNode({ target: { id: created.id }, format: 'tiptap' })),
    );
    assert.equal(asTipTap.entity.body.format, 'tiptap');
    const document = asTipTap.entity.body.value as { type: string };
    assert.equal(document.type, 'doc');

    assert.equal('path' in asTipTap.entity, false, 'a full path is only ever produced on request');
  });
});

test('a missing entity is not found, by id or by path', () => {
  withMigrated('read-missing', (connection) => {
    for (const target of [
      { id: 987_654 },
      { path: '/work/nothing-here' },
      { path: '/nope/deep' },
    ]) {
      const error = toPublicError(expectLeft(runNodes(connection, getNode({ target }))));
      assert.equal(error.code, 'node_not_found');
      assert.deepEqual(error.details, { field: 'target' });
    }
  });
});

test('the root is a scope, not an entity, and saying so is an input problem', () => {
  withMigrated('read-root', (connection) => {
    const error = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { path: '/' } }))),
    );
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, { field: 'target', reason: 'invalid' });
  });
});

test('a stored type this release cannot return is refused, not reported as absent', () => {
  withMigrated('read-resource', (connection) => {
    const created = seed(connection);
    insertNode(connection.db, {
      type: 'resource',
      parentId: created.id,
      parentType: 'project',
      slug: 'a-note',
      title: 'A note',
    });
    const resource = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE slug = ?',
      'a-note',
    ).id;

    for (const target of [{ id: resource }, { path: '/work/quarterly-plan/a-note' }]) {
      const error = toPublicError(expectLeft(runNodes(connection, getNode({ target }))));
      assert.equal(error.code, 'invalid_input');
      assert.deepEqual(
        error.details,
        { field: 'target', reason: 'unsupported_node_type', nodeType: 'resource' },
        'the node exists; what this release cannot do is represent it',
      );
    }
  });
});

test('a noncanonical path is an input problem rather than a missing node', () => {
  withMigrated('read-path-grammar', (connection) => {
    for (const path of ['/Work', '/work/', 'work', '/work//plan', '/work/../personal']) {
      const error = toPublicError(expectLeft(runNodes(connection, getNode({ target: { path } }))));
      assert.equal(error.code, 'invalid_input', path);
      assert.equal(error.details['field'], 'target');
    }
  });
});

test('the seeded root areas read cleanly on a fresh instance', () => {
  withMigrated('read-seeded', (connection) => {
    for (const slug of ['work', 'personal']) {
      const response = expectRight(runNodes(connection, getNode({ target: { path: `/${slug}` } })));
      assert.equal(response.entity.type, 'area');
      assert.equal(response.entity.parentId, null);
      assert.equal(response.entity.revision, 1);
      assert.deepEqual(response.entity.body, { format: 'markdown', value: '' });
      assert.deepEqual(response.entity.tags, []);
      assert.deepEqual(response.entity.metadata, {});
    }
  });
});

test('a stored body that is not valid canonical content is an integrity failure', () => {
  withMigrated('read-corrupt-body', (connection) => {
    const created = seed(connection);
    const update = connection.db.prepare('UPDATE nodes SET body = ? WHERE id = ?');

    const corruptions = [
      // Parseable JSON objects, each of which the canonicalization boundary refuses.
      '{"type":"doc","content":[{"type":"nonsense"}]}',
      '{"type":"paragraph"}',
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":6},"content":[]}]}',
      '{}',
    ];
    for (const body of corruptions) {
      update.run(body, created.id);
      const error = toPublicError(
        expectLeft(runNodes(connection, getNode({ target: { id: created.id } }))),
      );
      assert.equal(error.code, 'internal_error', body);
      assert.deepEqual(error.details, {}, 'nothing about stored content reaches the caller');
    }

    // Valid content that is not in its canonical form: the default attributes are missing. It would
    // survive a vocabulary check, which is exactly why the full boundary is used and the result compared.
    update.run(
      '{"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"x"}]}]}',
      created.id,
    );
    const notCanonical = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { id: created.id } }))),
    );
    assert.equal(notCanonical.code, 'internal_error');

    // And the read never repairs what it found.
    const after = one<{ body: string }>(
      connection.db,
      'SELECT body FROM nodes WHERE id = ?',
      created.id,
    );
    assert.equal(
      after.body,
      '{"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"x"}]}]}',
      'a read must not rewrite stored content it disagreed with',
    );
  });
});

test('stored fields SQLite cannot constrain are still validated before they are returned', () => {
  withMigrated('read-corrupt-fields', (connection) => {
    const created = seed(connection);

    // SQLite guarantees that `tags` is a JSON array, not that every element is a string.
    connection.db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run('[1,2]', created.id);
    const tags = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { id: created.id } }))),
    );
    assert.equal(tags.code, 'internal_error');

    connection.db
      .prepare('UPDATE nodes SET tags = ?, slug = ? WHERE id = ?')
      .run('[]', 'Not Canonical', created.id);
    const slug = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { id: created.id } }))),
    );
    assert.equal(
      slug.code,
      'internal_error',
      'a stored slug that could not be handed back as a selector is corrupt by core rules',
    );
  });
});
