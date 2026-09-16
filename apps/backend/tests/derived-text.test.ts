import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { Effect } from 'effect';

import { Db } from '../src/infrastructure/database/index.ts';
import {
  DERIVED_TEXT_BATCH_SIZE,
  backfillDerivedText,
  type BackfillOutcome,
  type SkipStage,
} from '../src/modules/nodes/derived-text.ts';
import { createNode, getNode } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  count,
  expectRight,
  insertNode,
  many,
  one,
  runNodes,
  withMigrated,
  withMigratedAsync,
} from './support.ts';

/**
 * The derived-text projection: written with the node, and filled in for rows that predate the column.
 *
 * The distinction these tests exist to hold is between a null projection and an empty one. Null means
 * nothing has read this row's body yet; the empty string means its body was read and has no text. A
 * pass that blurred the two would report rows as done that it never looked at.
 */

type Recorded = {
  readonly skipped: { nodeId: number; stage: SkipStage }[];
  readonly failures: string[];
  outcome: BackfillOutcome | undefined;
};

/**
 * Runs the pass to completion.
 *
 * `runPromise`, not `runSync`: the pass yields a macrotask between batches, so anything spanning more
 * than one batch is genuinely asynchronous. Forcing it synchronous would pass only for inputs small
 * enough to finish in a single batch, which is the case least worth testing.
 */
const runBackfill = async (
  connection: Parameters<typeof runNodes>[0],
  batchSize = DERIVED_TEXT_BATCH_SIZE,
): Promise<Recorded> => {
  const recorded: Recorded = { skipped: [], failures: [], outcome: undefined };
  const effect = backfillDerivedText({
    batchSize,
    onRowSkipped: (detail) => recorded.skipped.push({ ...detail }),
    onComplete: (outcome) => {
      recorded.outcome = outcome;
    },
    onFailure: (detail) => recorded.failures.push(detail),
  });
  await Effect.runPromise(
    Effect.provideService(effect, Db, {
      db: connection.db,
      databasePath: connection.databasePath,
    }),
  );
  return recorded;
};

const bodyTextOf = (connection: Parameters<typeof runNodes>[0], id: number): string | null =>
  one<{ bodyText: string | null }>(
    connection.db,
    'SELECT body_text AS bodyText FROM nodes WHERE id = ?',
    id,
  ).bodyText;

const nullCount = (connection: Parameters<typeof runNodes>[0]): number =>
  count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE body_text IS NULL');

describe('derivation at mutation time', () => {
  test('a creation commits its projection in the same transaction as the node', () => {
    withMigrated('derived-create', (connection) => {
      const response = expectRight(
        runNodes(
          connection,
          createNode({
            type: 'resource',
            kind: 'note',
            parent: { path: '/work' },
            title: 'A note',
            body: { value: '# Heading\n\nSome text.' },
          }),
          clockAt(1_700_000_000_000),
        ),
      );

      assert.equal(bodyTextOf(connection, response.entity.id), 'Heading\nSome text.');
    });
  });

  test('an empty body derives the empty string, which is a value rather than an absence', () => {
    withMigrated('derived-empty', (connection) => {
      const response = expectRight(
        runNodes(
          connection,
          createNode({ type: 'area', parent: { path: '/' }, title: 'Empty' }),
          clockAt(1_700_000_000_000),
        ),
      );

      assert.equal(
        bodyTextOf(connection, response.entity.id),
        '',
        'null would mean nobody had looked, which is not what happened here',
      );
    });
  });

  test('containers get a projection too, not only resources', () => {
    withMigrated('derived-container', (connection) => {
      const response = expectRight(
        runNodes(
          connection,
          createNode({
            type: 'project',
            parent: { path: '/work' },
            title: 'Holder',
            body: { value: 'Project notes.' },
          }),
          clockAt(1_700_000_000_000),
        ),
      );
      assert.equal(bodyTextOf(connection, response.entity.id), 'Project notes.');
    });
  });
});

describe('the backfill', () => {
  test('fills the seeded rows and leaves nothing null behind', async () => {
    await withMigratedAsync('derived-seeds', async (connection) => {
      // The bootstrap migration seeds two root areas with the canonical empty document and no
      // projection - the rows this pass actually exists for on a fresh database.
      assert.equal(nullCount(connection), 2);

      const recorded = await runBackfill(connection);

      assert.deepEqual(recorded.outcome, { examined: 2, written: 2, skipped: 0 });
      assert.deepEqual(recorded.failures, []);
      assert.equal(nullCount(connection), 0);
      for (const row of many<{ bodyText: string }>(
        connection.db,
        'SELECT body_text AS bodyText FROM nodes',
      )) {
        assert.equal(row.bodyText, '');
      }
    });
  });

  test('a later run finds nothing to do, because the null is the state', async () => {
    await withMigratedAsync('derived-idempotent', async (connection) => {
      await runBackfill(connection);
      const second = await runBackfill(connection);
      assert.deepEqual(second.outcome, { examined: 0, written: 0, skipped: 0 });
    });
  });

  test('a corrupt row stays null and is skipped, while the rows after it are still written', async () => {
    await withMigratedAsync('derived-corrupt', async (connection) => {
      await runBackfill(connection);

      // Written straight to storage, bypassing the operations, which is the only way such a row can
      // exist. `json_valid` is a column check, so the corruption has to be valid JSON that is not a
      // canonical document.
      insertNode(connection.db, {
        type: 'area',
        slug: 'broken',
        body: '{"type":"doc","content":[{"type":"marquee"}]}',
      });
      insertNode(connection.db, { type: 'area', slug: 'after', body: EMPTY_DOC });
      connection.db.prepare('UPDATE nodes SET body_text = NULL').run();

      const recorded = await runBackfill(connection);

      assert.equal(recorded.skipped.length, 1);
      assert.equal(recorded.skipped[0]?.stage, 'canonicalize');
      assert.equal(recorded.outcome?.skipped, 1);

      const broken = one<{ id: number; bodyText: string | null }>(
        connection.db,
        'SELECT id, body_text AS bodyText FROM nodes WHERE slug = ?',
        'broken',
      );
      assert.equal(broken.bodyText, null, 'nothing is repaired, and nothing is invented');
      assert.equal(recorded.skipped[0]?.nodeId, broken.id);

      const after = one<{ bodyText: string | null }>(
        connection.db,
        'SELECT body_text AS bodyText FROM nodes WHERE slug = ?',
        'after',
      );
      assert.equal(after.bodyText, '', 'a bad row is a step forward, not a stall');
    });
  });

  test('the cursor advances past a failed row rather than re-reading it forever', async () => {
    await withMigratedAsync('derived-cursor', async (connection) => {
      await runBackfill(connection);
      for (const slug of ['bad-one', 'bad-two']) {
        insertNode(connection.db, {
          type: 'area',
          slug,
          body: '{"type":"doc","content":[{"type":"marquee"}]}',
        });
      }
      insertNode(connection.db, { type: 'area', slug: 'good', body: EMPTY_DOC });
      connection.db.prepare('UPDATE nodes SET body_text = NULL').run();

      // A batch size of one forces every row into its own batch, which is where a cursor that did not
      // advance past an unwritable row would loop. Reaching the end at all is the assertion.
      const recorded = await runBackfill(connection, 1);
      assert.equal(recorded.outcome?.skipped, 2);
      assert.equal(recorded.outcome?.written, 3);
    });
  });

  test('a row written between inspection and update is not overwritten by a stale derivation', async () => {
    await withMigratedAsync('derived-revision-guard', async (connection) => {
      await runBackfill(connection);
      insertNode(connection.db, { type: 'area', slug: 'moving', body: EMPTY_DOC, revision: 1 });
      const id = one<{ id: number }>(
        connection.db,
        'SELECT id FROM nodes WHERE slug = ?',
        'moving',
      ).id;
      connection.db.prepare('UPDATE nodes SET body_text = NULL WHERE id = ?').run(id);

      // The revision guard makes the write apply only to the version that was read. Bumping it stands
      // in for the concurrent authored edit a future release will allow.
      connection.db.prepare('UPDATE nodes SET revision = 2 WHERE id = ?').run(id);
      connection.db
        .prepare('UPDATE nodes SET body = ? WHERE id = ?')
        .run(
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"new"}]}]}',
          id,
        );

      const recorded = await runBackfill(connection);
      // It reads the current row, so it derives the current text - the guard is what stops an older
      // derivation landing, and there is no older derivation in flight in a synchronous pass.
      assert.equal(bodyTextOf(connection, id), 'new');
      assert.equal(recorded.outcome?.skipped, 0);
    });
  });

  test('reads and writes keep working while projections are missing', async () => {
    await withMigratedAsync('derived-concurrent-ops', async (connection) => {
      const before = expectRight(
        runNodes(
          connection,
          createNode({ type: 'project', parent: { path: '/work' }, title: 'Holder' }),
          clockAt(1_700_000_000_000),
        ),
      );

      // Seeds are still null at this point; Get is not gated on the projection and never reads it.
      const read = expectRight(
        runNodes(connection, getNode({ target: { path: '/work' } }), clockAt(1_700_000_000_001)),
      );
      assert.equal(read.entity.slug, 'work');

      await runBackfill(connection);
      assert.equal(nullCount(connection), 0);
      assert.equal(bodyTextOf(connection, before.entity.id), '');
    });
  });

  test('the pass changes no revision and no timestamp', async () => {
    await withMigratedAsync('derived-no-side-effects', async (connection) => {
      const before = many<{ id: number; revision: number; updatedAt: number }>(
        connection.db,
        'SELECT id, revision, updated_at AS updatedAt FROM nodes ORDER BY id',
      );

      await runBackfill(connection);

      const after = many<{ id: number; revision: number; updatedAt: number }>(
        connection.db,
        'SELECT id, revision, updated_at AS updatedAt FROM nodes ORDER BY id',
      );
      assert.deepEqual(after, before, 'a missing projection is not an edit to the node');
    });
  });
});

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';
