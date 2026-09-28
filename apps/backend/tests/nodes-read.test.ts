import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode as createNodeRaw, getNode, toPublicError } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  expectLeft,
  expectRight,
  insertNode,
  one,
  runNodes,
  withMigrated,
  withDerivedSlug,
} from './support.ts';

const createNode = (request: unknown) => createNodeRaw(withDerivedSlug(request));

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
      assert.equal(error.message, 'Nothing exists at that address.');
    }
  });
});

test('the root is a scope, not an entity, and saying so is an input problem', () => {
  withMigrated('read-root', (connection) => {
    const error = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { path: '/' } }))),
    );
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, 'The target is not valid.');
  });
});

test('a resource is read like any other node, and carries its kind', () => {
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

    // Both selector forms reach it, and neither is a special path: a resource resolves and projects
    // exactly as a container does, with `kind` as the one field that tells them apart.
    for (const target of [{ id: resource }, { path: '/work/quarterly-plan/a-note' }]) {
      const { entity } = expectRight(runNodes(connection, getNode({ target })));
      assert.equal(entity.id, resource);
      assert.equal(entity.type, 'resource');
      assert.equal(entity.kind, 'note');
      assert.equal(entity.title, 'A note');
    }
  });
});

test('a noncanonical path is an input problem rather than a missing node', () => {
  withMigrated('read-path-grammar', (connection) => {
    for (const path of ['/Work', '/work/', 'work', '/work//plan', '/work/../personal']) {
      const error = toPublicError(expectLeft(runNodes(connection, getNode({ target: { path } }))));
      assert.equal(error.code, 'invalid_input', path);
      assert.equal(error.message, 'The target is not valid.');
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

test('a read says whether the project is selected, without being asked', () => {
  withMigrated('read-active', (connection) => {
    const created = seed(connection);
    assert.equal(
      expectRight(runNodes(connection, getNode({ target: { id: created.id } }))).entity.active,
      false,
    );

    connection.db.prepare('UPDATE nodes SET active = 1 WHERE id = ?').run(created.id);
    assert.equal(
      expectRight(runNodes(connection, getNode({ target: { id: created.id } }))).entity.active,
      true,
    );

    // And an area answers the same field truthfully rather than omitting it or answering null: "not
    // selected" is the honest answer for something that cannot be, and a consumer that needs "not
    // applicable" already has `type`.
    const work = expectRight(runNodes(connection, getNode({ target: { path: '/work' } }))).entity;
    assert.equal(work.type, 'area');
    assert.equal(work.active, false);
  });
});

test('get reports archived status and its causes, nearest origin first', () => {
  withMigrated('read-archived', (connection) => {
    const make = (request: Record<string, unknown>) =>
      expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;
    const shelf = make({ type: 'area', parent: { path: '/work' }, title: 'Shelf' });
    const apollo = make({ type: 'project', parent: { id: shelf.id }, title: 'Apollo' });
    const note = make({ type: 'resource', kind: 'note', parent: { id: apollo.id }, title: 'Note' });
    const get = (id: number) =>
      expectRight(runNodes(connection, getNode({ target: { id } }))).entity;
    const cause = (id: number, owner: string, reason: string) =>
      connection.db
        .prepare(
          'INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, owner, reason, T0);

    assert.equal(get(note.id).archived, false);
    assert.deepEqual(get(note.id).archiveCauses, []);

    // Direct.
    cause(apollo.id, 'user', 'direct');
    assert.deepEqual(get(apollo.id).archiveCauses, [
      {
        origin: { id: apollo.id, type: 'project', title: 'Apollo' },
        owner: 'user',
        reason: 'direct',
      },
    ]);

    // Inherited, through the project.
    const inherited = get(note.id);
    assert.equal(inherited.archived, true);
    assert.deepEqual(
      inherited.archiveCauses.map((c) => c.origin),
      [{ id: apollo.id, type: 'project', title: 'Apollo' }],
    );

    // Mixed: its own, the project's, and two on the area, ordered by distance, then owner, then reason.
    cause(note.id, 'user', 'direct');
    cause(shelf.id, 'user', 'direct');
    cause(shelf.id, 'ext_calendar', 'expired');
    assert.deepEqual(
      get(note.id).archiveCauses.map((c) => [c.origin.id, c.owner, c.reason]),
      [
        [note.id, 'user', 'direct'],
        [apollo.id, 'user', 'direct'],
        [shelf.id, 'ext_calendar', 'expired'],
        [shelf.id, 'user', 'direct'],
      ],
    );

    // An archived entity is still read, by path too, and its revision was never touched.
    const byPath = expectRight(
      runNodes(connection, getNode({ target: { path: '/work/shelf/apollo' } })),
    ).entity;
    assert.equal(byPath.archived, true);
    assert.equal(byPath.revision, apollo.revision);
  });
});
