import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode } from '../src/modules/nodes/index.ts';
import { controlledClock, expectRight, one, runNodes, withMigrated } from './support.ts';

const T0 = 1_700_000_000_000;

/**
 * Proving the request is detached, at the one moment where it matters.
 *
 * The window is narrow and real: the request is fingerprinted during preparation, and the values are
 * serialized later, inside the write transaction. If `metadata`, the TipTap body, or `tags` were still
 * the caller's objects, a mutation in between would store something the fingerprint does not describe -
 * so a retry would replay a result for a request that was never saved.
 *
 * The clock is the seam that reaches it. It is sampled inside the transaction, after fingerprinting and
 * before the insert, and the sample is the test's own function - so mutating there is deterministic
 * rather than a race. Without the copies taken during preparation, these assertions fail.
 */
test("mutating the caller's metadata after fingerprinting cannot change what is stored", () => {
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

/**
 * Stated precisely, because it was measured: this assertion currently holds for two independent reasons.
 * The tag schema is a transform, so the decoder already returns a fresh array, and preparation copies it
 * as well - removing the copy does not make this test fail today. It is kept because the invariant is
 * what matters rather than which layer happens to provide it, and a schema change that stopped copying
 * would otherwise be silent.
 */
test("mutating the caller's tags after fingerprinting cannot change what is stored", () => {
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

test("mutating the caller's TipTap body after fingerprinting cannot change what is stored", () => {
  withMigrated('detach-body', (connection) => {
    const value: { type: string; content: Record<string, unknown>[] } = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
    };
    const clock = controlledClock(() => {
      value.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'smuggled' }] });
      return T0;
    });

    const response = expectRight(
      runNodes(
        connection,
        createNode({
          type: 'project',
          parent: { path: '/work' },
          title: 'Detached body',
          body: { format: 'tiptap', value },
          // The key matters: it makes the preliminary replay lookup sample the clock, which is the one
          // point between fingerprinting and content conversion. Without it the only sample happens
          // after conversion, and the mutation would arrive too late to prove anything.
          idempotencyKey: 'detached-body',
        }),
        clock,
      ),
    );

    assert.ok(
      value.content.length > 1,
      "the caller's own object was in fact mutated mid-operation",
    );
    assert.deepEqual(response.entity.body, { format: 'markdown', value: 'original' });
    const stored = one<{ body: string }>(
      connection.db,
      'SELECT body FROM nodes WHERE id = ?',
      response.entity.id,
    ).body;
    assert.equal(
      stored.includes('smuggled'),
      false,
      "content converted from the snapshot, not from the caller's live object",
    );
  });
});
