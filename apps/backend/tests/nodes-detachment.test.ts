import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode as createNodeRaw } from '../src/modules/nodes/index.ts';
import {
  controlledClock,
  expectRight,
  one,
  runNodes,
  withMigrated,
  withDerivedSlug,
} from './support.ts';

const createNode = (request: unknown) => createNodeRaw(withDerivedSlug(request));

const T0 = 1_700_000_000_000;

/**
 * Proving the request is detached: `metadata` and `tags` are serialized inside the write transaction,
 * after the request was decoded. The clock is sampled there, before the insert, and the sample is the
 * test's own function - so mutating the caller's objects there is deterministic rather than a race.
 */
test("mutating the caller's metadata after decoding cannot change what is stored", () => {
  withMigrated('detach-metadata', (connection) => {
    const metadata = { owner: 'original', nested: { value: 'original' } };
    const clock = controlledClock(() => {
      metadata.owner = 'mutated';
      metadata.nested.value = 'mutated';
      return T0;
    });

    const response = expectRight(
      runNodes(
        connection,
        createNode({ type: 'project', parent: { path: '/work' }, title: 'Detached', metadata }),
        clock,
      ),
    );

    assert.equal(
      metadata.owner,
      'mutated',
      "the caller's own object was in fact mutated mid-operation",
    );
    assert.deepEqual(response.entity.metadata, {
      owner: 'original',
      nested: { value: 'original' },
    });
    const stored = one<{ metadata: string }>(
      connection.db,
      'SELECT metadata FROM nodes WHERE id = ?',
      response.entity.id,
    ).metadata;
    assert.deepEqual(JSON.parse(stored), { owner: 'original', nested: { value: 'original' } });
  });
});

/** The tag schema is a transform, so the decoder already returns a fresh array; this holds it to that. */
test("mutating the caller's tags after decoding cannot change what is stored", () => {
  withMigrated('detach-tags', (connection) => {
    const tags = ['first'];
    const clock = controlledClock(() => {
      tags.push('smuggled');
      return T0;
    });

    const response = expectRight(
      runNodes(
        connection,
        createNode({ type: 'project', parent: { path: '/work' }, title: 'Detached tags', tags }),
        clock,
      ),
    );

    assert.deepEqual(tags, ['first', 'smuggled']);
    assert.deepEqual(response.entity.tags, ['first']);
    const stored = one<{ tags: string }>(
      connection.db,
      'SELECT tags FROM nodes WHERE id = ?',
      response.entity.id,
    ).tags;
    assert.deepEqual(JSON.parse(stored), ['first']);
  });
});
