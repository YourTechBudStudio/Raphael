import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNode as createNodeRaw,
  getNode,
  listNodes,
  toPublicError,
} from '../src/modules/nodes/index.ts';
import {
  clockAt,
  count,
  expectLeft,
  expectRight,
  one,
  openMigrated,
  runNodes,
  tempDatabase,
  withDerivedSlug,
} from './support.ts';

const createNode = (request: unknown) => createNodeRaw(withDerivedSlug(request));

const T0 = 1_700_000_000_000;

test('what was created survives closing and reopening the database', () => {
  const temp = tempDatabase('durability');
  const body = '# Goals\n\n- one\n- two';
  let createdId = 0;

  try {
    // First process: create, then release ownership the way a clean shutdown does.
    const first = openMigrated(temp.file);
    try {
      const created = expectRight(
        runNodes(
          first,
          createNode({
            type: 'project',
            parent: { path: '/work' },
            title: 'Quarterly plan',
            description: 'The plan',
            tags: ['planning'],
            metadata: { owner: 'me' },
            body: { value: body },
          }),
          clockAt(T0),
        ),
      );
      createdId = created.entity.id;
    } finally {
      first.close();
    }

    // Second process: the same database, a new connection, no migration to apply.
    const second = openMigrated(temp.file);
    try {
      const reread = expectRight(runNodes(second, getNode({ target: { id: createdId } })));
      assert.equal(reread.entity.title, 'Quarterly plan');
      assert.equal(reread.entity.description, 'The plan');
      assert.deepEqual(reread.entity.tags, ['planning']);
      assert.deepEqual(reread.entity.metadata, { owner: 'me' });
      assert.deepEqual(
        reread.entity.body,
        { format: 'markdown', value: body },
        'the stored canonical document still validates and still exports to the same Markdown',
      );

      const byPath = expectRight(
        runNodes(second, getNode({ target: { path: '/work/quarterly-plan' } })),
      );
      assert.equal(byPath.entity.id, createdId);

      const listed = expectRight(runNodes(second, listNodes({ scopes: [{ path: '/work' }] })));
      assert.deepEqual(
        listed.items.map((item) => item.slug),
        ['quarterly-plan'],
      );

      // A retry after a crash resubmits the same slug and meets its own first attempt.
      const retried = expectLeft(
        runNodes(
          second,
          createNode({ type: 'project', parent: { path: '/work' }, title: 'Quarterly plan' }),
          clockAt(T0 + 5_000),
        ),
      );
      assert.equal(toPublicError(retried).code, 'slug_conflict');
    } finally {
      second.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('a note comes back whole after a restart, and a retry does not duplicate it', () => {
  const temp = tempDatabase('durability-note');
  const body = '# API design\n\nRequest contracts.';
  let createdId = 0;
  let createdAt = 0;

  try {
    // First process: create a note, then release ownership the way a clean shutdown does.
    const first = openMigrated(temp.file);
    try {
      const created = expectRight(
        runNodes(
          first,
          createNode({
            type: 'resource',
            kind: 'note',
            parent: { path: '/work' },
            title: 'API design',
            body: { value: body },
          }),
          clockAt(T0),
        ),
      );
      assert.equal(created.entity.slug, 'api-design');
      createdId = created.entity.id;
      createdAt = one<{ updatedAt: number }>(
        first.db,
        'SELECT updated_at AS updatedAt FROM nodes WHERE id = ?',
        createdId,
      ).updatedAt;
    } finally {
      first.close();
    }

    const second = openMigrated(temp.file);
    try {
      const reread = expectRight(runNodes(second, getNode({ target: { id: createdId } })));
      assert.equal(reread.entity.type, 'resource');
      assert.equal(reread.entity.kind, 'note');
      assert.equal(reread.entity.title, 'API design');
      assert.equal(reread.entity.slug, 'api-design');
      assert.equal(reread.entity.revision, 1);
      assert.deepEqual(
        reread.entity.body,
        { format: 'markdown', value: body },
        'the stored canonical document still validates and still exports to the same Markdown',
      );

      // The derived projection is storage, not a response field, so it is inspected where it lives.
      const stored = one<{ kind: string | null; bodyText: string | null }>(
        second.db,
        'SELECT kind, body_text AS bodyText FROM nodes WHERE id = ?',
        createdId,
      );
      assert.equal(stored.kind, 'note');
      assert.equal(stored.bodyText, 'API design\nRequest contracts.');

      const byPath = expectRight(
        runNodes(second, getNode({ target: { path: '/work/api-design' } })),
      );
      assert.equal(byPath.entity.id, createdId);

      const listed = expectRight(
        runNodes(second, listNodes({ scopes: [{ path: '/work' }], filter: { type: 'resource' } })),
      );
      assert.deepEqual(
        listed.items.map((item) => item.slug),
        ['api-design'],
      );
      assert.equal(listed.items[0]?.kind, 'note');

      // A retry after a lost reply resubmits the same slug, so it is refused rather than duplicated.
      const retried = expectLeft(
        runNodes(
          second,
          createNode({
            type: 'resource',
            kind: 'note',
            parent: { path: '/work' },
            title: 'API design',
            body: { value: body },
          }),
          clockAt(T0 + 5_000),
        ),
      );
      assert.equal(toPublicError(retried).code, 'slug_conflict');
      assert.equal(count(second.db, `SELECT count(*) AS c FROM nodes WHERE type = 'resource'`), 1);

      // The refused retry did not touch the note.
      assert.equal(
        one<{ updatedAt: number }>(
          second.db,
          'SELECT updated_at AS updatedAt FROM nodes WHERE id = ?',
          createdId,
        ).updatedAt,
        createdAt,
      );
    } finally {
      second.close();
    }
  } finally {
    temp.cleanup();
  }
});
