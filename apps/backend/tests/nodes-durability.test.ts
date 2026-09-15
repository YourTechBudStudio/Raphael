import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, listNodes } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  count,
  expectRight,
  one,
  openMigrated,
  runNodes,
  tempDatabase,
} from './support.ts';

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
            idempotencyKey: 'survives-restart',
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

      const listed = expectRight(runNodes(second, listNodes({ parent: { path: '/work' } })));
      assert.deepEqual(
        listed.items.map((item) => item.slug),
        ['quarterly-plan'],
      );

      // The replay record outlived the restart too, so a retry after a crash still deduplicates.
      const replayed = expectRight(
        runNodes(
          second,
          createNode({
            type: 'project',
            parent: { path: '/work' },
            title: 'Quarterly plan',
            description: 'The plan',
            tags: ['planning'],
            metadata: { owner: 'me' },
            body: { value: body },
            idempotencyKey: 'survives-restart',
          }),
          clockAt(T0 + 5_000),
        ),
      );
      assert.equal(
        replayed.entity.id,
        createdId,
        'a retry after a restart replays rather than duplicates',
      );
    } finally {
      second.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('a note created without a title comes back whole after a restart', () => {
  const temp = tempDatabase('durability-note');
  const body = '# API design\n\nRequest contracts.';
  let createdId = 0;
  let createdAt = 0;

  try {
    // First process: create a note that names itself from its content, then release ownership the
    // way a clean shutdown does.
    const first = openMigrated(temp.file);
    try {
      const created = expectRight(
        runNodes(
          first,
          createNode({
            type: 'resource',
            kind: 'note',
            parent: { path: '/work' },
            body: { value: body },
            idempotencyKey: 'note-survives-restart',
          }),
          clockAt(T0),
        ),
      );
      assert.equal(created.entity.title, 'API design', 'the title was derived, not supplied');
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
      // Its survival is what makes the maintenance pass a backfill for older rows rather than
      // something every restart has to redo.
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
        runNodes(second, listNodes({ parent: { path: '/work' }, types: ['resource'] })),
      );
      assert.deepEqual(
        listed.items.map((item) => item.slug),
        ['api-design'],
      );
      assert.equal(listed.items[0]?.kind, 'note');

      // The receipt outlived the restart, and it answers with the title the server resolved - which
      // the request never carried, so a retry after a crash learns what was actually created.
      const replayed = expectRight(
        runNodes(
          second,
          createNode({
            type: 'resource',
            kind: 'note',
            parent: { path: '/work' },
            body: { value: body },
            idempotencyKey: 'note-survives-restart',
          }),
          clockAt(T0 + 5_000),
        ),
      );
      assert.deepEqual(replayed.entity, reread.entity);
      assert.equal(
        count(second.db, `SELECT count(*) AS c FROM nodes WHERE type = 'resource'`),
        1,
        'a replay reports the entity that exists rather than creating a second one',
      );

      // A replay is not an edit, so it must not make the note look recently touched - which would
      // silently reorder a recency-ordered feed.
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
