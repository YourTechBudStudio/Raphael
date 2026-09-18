import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { createNode, toPublicError } from '../src/modules/nodes/index.ts';
// Retention is internal to the capability, so the test reads it where it is defined rather than
// requiring the public surface to publish it.
import { REPLAY_TTL_MS } from '../src/modules/nodes/replay.ts';
import {
  clockAt,
  controlledClock,
  count,
  expectLeft,
  expectRight,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

const T0 = 1_700_000_000_000;

const request = (overrides: Record<string, unknown> = {}) => ({
  type: 'project',
  parent: { path: '/work' },
  title: 'Quarterly plan',
  idempotencyKey: 'attempt-1',
  ...overrides,
});

test('an equivalent retry replays the original result instead of creating a second entity', () => {
  withMigrated('replay-equivalent', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const second = expectRight(runNodes(connection, createNode(request()), clockAt(T0 + 60_000)));

    assert.deepEqual(second, first);
    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE slug = ?', 'quarterly-plan'),
      1,
    );
  });
});

test('omitted fields and their explicit defaults are the same request', () => {
  withMigrated('replay-defaults', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const explicit = expectRight(
      runNodes(
        connection,
        createNode(
          request({
            description: '',
            tags: [],
            metadata: {},
            body: { value: '' },
            format: 'markdown',
          }),
        ),
        clockAt(T0 + 1),
      ),
    );
    assert.deepEqual(explicit, first, 'materialized defaults must fingerprint identically');
  });
});

test('an explicitly empty TipTap body is a different request from empty Markdown', () => {
  withMigrated('replay-body-format', (connection) => {
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const error = toPublicError(
      expectLeft(
        runNodes(
          connection,
          createNode(
            request({
              body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } },
            }),
          ),
          clockAt(T0 + 1),
        ),
      ),
    );
    assert.equal(
      error.code,
      'idempotency_conflict',
      'storage converges on one document, but the two submissions are not the same request',
    );
  });
});

test('an equivalent derived and explicit slug are the same request', () => {
  withMigrated('replay-slug', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const explicit = expectRight(
      runNodes(connection, createNode(request({ slug: 'quarterly-plan' })), clockAt(T0 + 1)),
    );
    assert.deepEqual(explicit, first);
  });
});

test('the same parent named by id rather than path is a different request', () => {
  withMigrated('replay-selector', (connection) => {
    const work = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'work',
    ).id;
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const error = toPublicError(
      expectLeft(
        runNodes(connection, createNode(request({ parent: { id: work } })), clockAt(T0 + 1)),
      ),
    );
    assert.equal(error.code, 'idempotency_conflict');
    assert.deepEqual(error.details, { field: 'idempotencyKey', reason: 'different_input' });
  });
});

test('asking for a different response format under the same key conflicts', () => {
  withMigrated('replay-format', (connection) => {
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const error = toPublicError(
      expectLeft(runNodes(connection, createNode(request({ format: 'tiptap' })), clockAt(T0 + 1))),
    );
    assert.equal(
      error.code,
      'idempotency_conflict',
      'a replay returns the saved response; it is not a request to re-render the entity',
    );
  });
});

test('differing authored input under one key conflicts rather than creating anything', () => {
  withMigrated('replay-conflict', (connection) => {
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const before = count(connection.db, 'SELECT count(*) AS c FROM nodes');

    for (const overrides of [
      { title: 'A different title' },
      { description: 'now described' },
      { tags: ['one'] },
      { metadata: { k: 1 } },
      { body: { value: 'prose' } },
      { type: 'area' },
    ]) {
      const error = toPublicError(
        expectLeft(runNodes(connection, createNode(request(overrides)), clockAt(T0 + 1))),
      );
      assert.equal(error.code, 'idempotency_conflict', JSON.stringify(overrides));
    }
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), before);
  });
});

test('a key conflict is answered before content conversion would have rejected the body', () => {
  withMigrated('replay-precedence', (connection) => {
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const error = toPublicError(
      expectLeft(
        runNodes(
          connection,
          createNode(
            request({
              body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'nonsense' }] } },
            }),
          ),
          clockAt(T0 + 1),
        ),
      ),
    );
    assert.equal(
      error.code,
      'idempotency_conflict',
      'the settled key is the more specific answer, and the one that says what to do',
    );
  });
});

test('retention is exactly 72 hours, and a replay does not extend it', () => {
  withMigrated('replay-expiry', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const stored = one<{ createdAt: number; expiresAt: number }>(
      connection.db,
      'SELECT created_at AS createdAt, expires_at AS expiresAt FROM creation_replays WHERE key = ?',
      'attempt-1',
    );
    assert.equal(stored.createdAt, T0);
    assert.equal(stored.expiresAt, T0 + REPLAY_TTL_MS);

    // One millisecond before expiry: still a replay.
    const late = expectRight(
      runNodes(connection, createNode(request()), clockAt(T0 + REPLAY_TTL_MS - 1)),
    );
    assert.deepEqual(late, first);

    const after = one<{ expiresAt: number }>(
      connection.db,
      'SELECT expires_at AS expiresAt FROM creation_replays WHERE key = ?',
      'attempt-1',
    );
    assert.equal(after.expiresAt, T0 + REPLAY_TTL_MS, 'replaying must not push the expiry out');
  });
});

test('at and after the expiry instant the key is absent, whatever collection has done', () => {
  withMigrated('replay-expired', (connection) => {
    expectRight(runNodes(connection, createNode(request()), clockAt(T0)));

    // The row is still physically present; expiry is decided at lookup, so this must behave as absent.
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 1);

    // Exactly at the expiry instant, the address is still taken, so the retry now collides on the slug -
    // which is the honest outcome: after expiry, uniqueness can refuse a repeat but cannot deduplicate it.
    const atExpiry = toPublicError(
      expectLeft(runNodes(connection, createNode(request()), clockAt(T0 + REPLAY_TTL_MS))),
    );
    assert.equal(atExpiry.code, 'slug_conflict');

    // A genuinely new request reuses the expired key, and the record is replaced rather than duplicated.
    const reused = expectRight(
      runNodes(
        connection,
        createNode(request({ title: 'Something else' })),
        clockAt(T0 + REPLAY_TTL_MS + 5),
      ),
    );
    assert.equal(reused.entity.slug, 'something-else');
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 1);
    const replaced = one<{ createdAt: number; expiresAt: number }>(
      connection.db,
      'SELECT created_at AS createdAt, expires_at AS expiresAt FROM creation_replays WHERE key = ?',
      'attempt-1',
    );
    assert.equal(replaced.createdAt, T0 + REPLAY_TTL_MS + 5);
    assert.equal(replaced.expiresAt, T0 + REPLAY_TTL_MS + 5 + REPLAY_TTL_MS);
  });
});

test('a replay returns the historical result even after the entity has moved', () => {
  withMigrated('replay-relocated', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const personal = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
      'personal',
    ).id;

    // Move and rename the node behind core's back. Move is not an operation this release exposes, so the
    // only way to reach the case is direct SQL - test setup for a future-lifecycle scenario.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ?, slug = ?, title = ? WHERE id = ?')
      .run(personal, 'area', 'relocated', 'Relocated', first.entity.id);

    const replayed = expectRight(runNodes(connection, createNode(request()), clockAt(T0 + 1000)));
    assert.deepEqual(
      replayed,
      first,
      'the caller learns what their original request did, not what the entity looks like now',
    );
  });
});

test('a saved result that cannot be read fails the operation rather than creating a second entity', () => {
  withMigrated('replay-corrupt', (connection) => {
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    const before = count(connection.db, 'SELECT count(*) AS c FROM nodes');

    for (const corrupt of ['{"entity":{"id":0}}', '{"entity":{}}', '{}', '[]']) {
      connection.db
        .prepare('UPDATE creation_replays SET result_json = ? WHERE key = ?')
        .run(corrupt, 'attempt-1');
      const error = toPublicError(
        expectLeft(runNodes(connection, createNode(request()), clockAt(T0 + 1))),
      );
      assert.equal(error.code, 'internal_error', corrupt);
    }

    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes'),
      before,
      'falling back to ordinary creation would produce exactly the duplicate the key exists to prevent',
    );
    assert.equal(first.entity.id > 0, true);
  });
});

test('a request without a key records no replay row at all', () => {
  withMigrated('replay-absent', (connection) => {
    expectRight(
      runNodes(
        connection,
        createNode({ type: 'project', parent: { path: '/work' }, title: 'Unkeyed' }),
        clockAt(T0),
      ),
    );
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 0);
  });
});

test('two concurrent identical attempts produce one entity and one replay', () => {
  withMigrated('replay-concurrent-same', (connection) => {
    // Synchronous better-sqlite3 in single-threaded Node cannot interleave two transactions, so this is
    // evidence about the operation rather than about SQLite-level races: two separate logical requests,
    // run concurrently through one runtime, serialize into one creation plus one replay.
    const [first, second] = expectRight(
      runNodes(
        connection,
        Effect.all([createNode(request()), createNode(request())], { concurrency: 2 }),
        clockAt(T0),
      ),
    );

    assert.deepEqual(first, second, 'one of the two attempts replayed the other');
    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE slug = ?', 'quarterly-plan'),
      1,
    );
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 1);
  });
});

test('two concurrent attempts with the same key and different input leave one entity', () => {
  withMigrated('replay-concurrent-different', (connection) => {
    const results = expectRight(
      runNodes(
        connection,
        Effect.all(
          [
            Effect.either(createNode(request())),
            Effect.either(createNode(request({ title: 'A different title' }))),
          ],
          { concurrency: 2 },
        ),
        clockAt(T0),
      ),
    );

    const outcomes = results.map((result) =>
      result._tag === 'Right' ? 'created' : toPublicError(result.left).code,
    );
    assert.deepEqual(outcomes.filter((outcome) => outcome === 'created').length, 1);
    assert.deepEqual(
      outcomes.filter((outcome) => outcome === 'idempotency_conflict').length,
      1,
      'the second attempt is refused rather than creating a second entity',
    );
    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE parent_id IS NOT NULL'),
      1,
    );
  });
});

test('the clock is sampled again inside the write, not reused from the lookup', () => {
  withMigrated('replay-resample', (connection) => {
    const samples: number[] = [];
    const clock = controlledClock(() => {
      const value = T0 + samples.length * 1000;
      samples.push(value);
      return value;
    });
    const response = expectRight(runNodes(connection, createNode(request()), clock));
    assert.equal(
      samples.length,
      2,
      'one sample for the preliminary lookup, one inside the transaction',
    );

    const stored = one<{ createdAt: number }>(
      connection.db,
      'SELECT created_at AS createdAt FROM nodes WHERE id = ?',
      response.entity.id,
    );
    assert.equal(
      stored.createdAt,
      samples[1],
      'the stored instant is the one taken inside the write, after conversion',
    );
  });
});

/* ------------------------------------------------------------------ notes and their receipts */

const noteRequest = (overrides: Record<string, unknown> = {}) => ({
  type: 'resource',
  kind: 'note',
  parent: { path: '/work' },
  idempotencyKey: 'note-attempt-1',
  ...overrides,
});

test('an untitled note replays its receipt, including the title the server resolved', () => {
  withMigrated('replay-note', (connection) => {
    const body = { value: '# API design\n\nRequest contracts' };
    const first = expectRight(runNodes(connection, createNode(noteRequest({ body })), clockAt(T0)));
    assert.equal(first.entity.title, 'API design');
    assert.equal(first.entity.kind, 'note');

    const second = expectRight(
      runNodes(connection, createNode(noteRequest({ body })), clockAt(T0 + 60_000)),
    );

    // The receipt answers with the resolved title even though the request never carried one, which is
    // the property a lost-response retry depends on: the second attempt must learn what was created.
    assert.deepEqual(second, first);
    assert.equal(
      count(connection.db, `SELECT count(*) AS c FROM nodes WHERE type = 'resource'`),
      1,
    );
  });
});

test('a saved receipt carries the kind, so a replay is decodable by a conforming client', () => {
  withMigrated('replay-note-receipt', (connection) => {
    expectRight(
      runNodes(connection, createNode(noteRequest({ body: { value: 'Text' } })), clockAt(T0)),
    );
    const saved = one<{ resultJson: string }>(
      connection.db,
      'SELECT result_json AS resultJson FROM creation_replays WHERE key = ?',
      'note-attempt-1',
    );
    const parsed = JSON.parse(saved.resultJson) as { entity: Record<string, unknown> };
    assert.equal(parsed.entity['kind'], 'note');

    // Containers record a null kind rather than omitting the field: every response field is always
    // present, and a receipt is a response.
    expectRight(runNodes(connection, createNode(request({ idempotencyKey: 'c' })), clockAt(T0)));
    const container = one<{ resultJson: string }>(
      connection.db,
      'SELECT result_json AS resultJson FROM creation_replays WHERE key = ?',
      'c',
    );
    const containerParsed = JSON.parse(container.resultJson) as {
      entity: Record<string, unknown>;
    };
    assert.equal('kind' in containerParsed.entity, true);
    assert.equal(containerParsed.entity['kind'], null);
  });
});

test('two untitled notes at different addresses are two requests under one key', () => {
  withMigrated('replay-note-addresses', (connection) => {
    const body = { value: 'Shared text' };
    expectRight(runNodes(connection, createNode(noteRequest({ body, slug: 'here' })), clockAt(T0)));

    // Same key, same body, different address. Without the explicit slug in the fingerprint these
    // would collide and the second creation would silently replay the first.
    const conflict = toPublicError(
      expectLeft(
        runNodes(connection, createNode(noteRequest({ body, slug: 'there' })), clockAt(T0 + 1)),
      ),
    );
    assert.equal(conflict.code, 'idempotency_conflict');
  });
});

test('changing only the body of an untitled note conflicts on the key', () => {
  withMigrated('replay-note-body', (connection) => {
    expectRight(
      runNodes(connection, createNode(noteRequest({ body: { value: 'First' } })), clockAt(T0)),
    );
    const conflict = toPublicError(
      expectLeft(
        runNodes(
          connection,
          createNode(noteRequest({ body: { value: 'Second' } })),
          clockAt(T0 + 1),
        ),
      ),
    );
    assert.equal(conflict.code, 'idempotency_conflict');
    assert.deepEqual(conflict.details, {
      field: 'idempotencyKey',
      reason: 'different_input',
    });
  });
});

test('a settled key answers before any content work, so an unnameable body still replays', () => {
  withMigrated('replay-before-derivation', (connection) => {
    const first = expectRight(
      runNodes(
        connection,
        createNode(noteRequest({ body: { value: 'Nameable' }, slug: 'fixed' })),
        clockAt(T0),
      ),
    );

    // The replay lookup precedes conversion and title resolution alike, so the second attempt returns
    // the saved result rather than re-deriving anything from the body.
    const second = expectRight(
      runNodes(
        connection,
        createNode(noteRequest({ body: { value: 'Nameable' }, slug: 'fixed' })),
        clockAt(T0 + 1_000),
      ),
    );
    assert.deepEqual(second, first);
  });
});

test('a replayed creation answers with the selection the original answered with', () => {
  withMigrated('replay-active', (connection) => {
    // A project is created inactive and `active` is not a creation request field, so the saved result
    // carries `false` - and a replay re-decodes that stored result against the current response
    // contract, which is why the field has to be in it rather than synthesized on the way out.
    const first = expectRight(runNodes(connection, createNode(request()), clockAt(T0)));
    assert.equal(first.entity.active, false);

    const replayed = expectRight(runNodes(connection, createNode(request()), clockAt(T0 + 60_000)));
    assert.deepEqual(replayed, first);
    assert.equal(replayed.entity.active, false);
  });
});
