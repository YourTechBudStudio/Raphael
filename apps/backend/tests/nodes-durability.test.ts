import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, listNodes } from '../src/modules/nodes/index.ts';
import { clockAt, expectRight, openMigrated, runNodes, tempDatabase } from './support.ts';

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
