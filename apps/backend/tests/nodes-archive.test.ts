import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveNode,
  createNode,
  getNode,
  restoreNode,
  toPublicError,
} from '../src/modules/nodes/index.ts';
import {
  clockAt,
  count,
  expectLeft,
  expectRight,
  many,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

/**
 * Archive and restore: one cause row on the target, one revision bump when it changed, and an answer
 * that states the resulting status rather than echoing the verb.
 *
 * Every refusal and every no-op is also checked for what it did *not* write: the cause rows and the
 * target's row are compared before and after.
 */

type Connection = Parameters<typeof runNodes>[0];

const T0 = 1_700_000_000_000;
const AT = T0 + 5_000;
const LATER = T0 + 9_000;

const archive = (connection: Connection, request: unknown, at = AT) =>
  runNodes(connection, archiveNode(request), clockAt(at));
const restore = (connection: Connection, request: unknown, at = AT) =>
  runNodes(connection, restoreNode(request), clockAt(at));

const create = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;

const area = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'area', parent, title });
const project = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'project', parent, title });
const note = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'resource', kind: 'note', parent, title });

const get = (connection: Connection, id: number) =>
  expectRight(runNodes(connection, getNode({ target: { id } }))).entity;

interface Row {
  readonly revision: number;
  readonly updatedAt: number;
}

const row = (connection: Connection, id: number): Row =>
  one<Row>(connection.db, 'SELECT revision, updated_at AS updatedAt FROM nodes WHERE id = ?', id);

const causeRows = (connection: Connection) =>
  many<{ nodeId: number; owner: string; reason: string; createdAt: number }>(
    connection.db,
    `SELECT node_id AS nodeId, owner, reason, created_at AS createdAt
     FROM archive_causes ORDER BY node_id, owner, reason`,
  );

/** Archives through the operation, at the node's current revision. */
const archived = (connection: Connection, id: number, at = AT) =>
  expectRight(archive(connection, { target: { id }, revision: row(connection, id).revision }, at));

const direct = (id: number, type: string, title: string) => ({
  origin: { id, type, title },
  owner: 'user',
  reason: 'direct',
});

test('archive writes one direct user cause and bumps only the target', () => {
  withMigrated('archive-writes', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');

    const response = expectRight(
      archive(connection, { target: { id: target.id }, revision: target.revision }),
    );

    assert.equal(response.node.archived, true);
    assert.equal(response.node.revision, target.revision + 1);
    assert.deepEqual(response.archiveCauses, [direct(target.id, 'project', 'Apollo')]);
    assert.deepEqual(causeRows(connection), [
      { nodeId: target.id, owner: 'user', reason: 'direct', createdAt: AT },
    ]);
    assert.deepEqual(row(connection, target.id), { revision: target.revision + 1, updatedAt: AT });
  });
});

test('archiving what the user already archived succeeds without writing', () => {
  withMigrated('archive-repeat', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const first = archived(connection, target.id);
    const before = row(connection, target.id);

    const again = expectRight(
      archive(connection, { target: { id: target.id }, revision: first.node.revision }, LATER),
    );

    assert.deepEqual(again, first);
    assert.deepEqual(row(connection, target.id), before, 'no revision or timestamp change');
    assert.equal(causeRows(connection).length, 1, 'no duplicate cause');
  });
});

test('restore removes the direct cause, and a restore with none present writes nothing', () => {
  withMigrated('archive-restore', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const first = archived(connection, target.id);

    const restored = expectRight(
      restore(connection, { target: { id: target.id }, revision: first.node.revision }, LATER),
    );
    assert.equal(restored.node.archived, false);
    assert.deepEqual(restored.archiveCauses, []);
    assert.equal(restored.node.revision, first.node.revision + 1);
    assert.deepEqual(row(connection, target.id), {
      revision: first.node.revision + 1,
      updatedAt: LATER,
    });
    assert.deepEqual(causeRows(connection), []);

    // Nothing to remove: success, same revision, and the truthful (active) state.
    const again = expectRight(
      restore(connection, { target: { id: target.id }, revision: restored.node.revision }),
    );
    assert.deepEqual(again, restored);
    assert.deepEqual(row(connection, target.id), {
      revision: first.node.revision + 1,
      updatedAt: LATER,
    });
  });
});

test('a stale revision is a revision conflict before anything else, in both directions', () => {
  withMigrated('archive-stale', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const other = project(connection, { path: '/work' }, 'Other');
    archived(connection, other.id);
    const before = { row: row(connection, target.id), causes: causeRows(connection) };

    for (const run of [archive, restore]) {
      const failure = toPublicError(
        expectLeft(run(connection, { target: { id: target.id }, revision: target.revision + 1 })),
      );
      assert.equal(failure.code, 'revision_conflict');
      assert.deepEqual(failure.details, { field: 'revision', currentRevision: target.revision });
    }

    // A stale restore of something archived is still a conflict, not a no-op or a removal.
    const archivedOther = row(connection, other.id);
    const failure = toPublicError(
      expectLeft(
        restore(connection, { target: { id: other.id }, revision: archivedOther.revision - 1 }),
      ),
    );
    assert.equal(failure.code, 'revision_conflict');
    assert.deepEqual(
      { row: row(connection, target.id), causes: causeRows(connection) },
      before,
      'nothing was written',
    );
  });
});

test('restoring an ancestor keeps an independent cause below it (ADR 0003)', () => {
  withMigrated('archive-adr-example', (connection) => {
    const backend = project(connection, { path: '/work' }, 'Backend');
    const plain = note(connection, { id: backend.id }, 'Plain');
    const independent = note(connection, { id: backend.id }, 'Independent');
    archived(connection, independent.id);
    archived(connection, backend.id);

    assert.deepEqual(get(connection, plain.id).archiveCauses, [
      direct(backend.id, 'project', 'Backend'),
    ]);
    assert.deepEqual(get(connection, independent.id).archiveCauses, [
      direct(independent.id, 'resource', 'Independent'),
      direct(backend.id, 'project', 'Backend'),
    ]);

    expectRight(
      restore(connection, {
        target: { id: backend.id },
        revision: row(connection, backend.id).revision,
      }),
    );

    assert.equal(get(connection, backend.id).archived, false);
    assert.equal(get(connection, plain.id).archived, false);
    const kept = get(connection, independent.id);
    assert.equal(kept.archived, true);
    assert.deepEqual(kept.archiveCauses, [direct(independent.id, 'resource', 'Independent')]);
  });
});

test('archiving a container leaves every descendant row untouched', () => {
  withMigrated('archive-descendants', (connection) => {
    const outer = area(connection, { path: '/work' }, 'Outer');
    const inner = area(connection, { id: outer.id }, 'Inner');
    const apollo = project(connection, { id: inner.id }, 'Apollo');
    const leaf = note(connection, { id: apollo.id }, 'Leaf');
    const descendants = [inner.id, apollo.id, leaf.id];
    const before = descendants.map((id) => row(connection, id));

    archived(connection, outer.id);

    assert.deepEqual(
      descendants.map((id) => row(connection, id)),
      before,
      'no descendant revision or timestamp moved',
    );
    assert.deepEqual(
      causeRows(connection).map((cause) => cause.nodeId),
      [outer.id],
    );
    for (const id of descendants) {
      assert.deepEqual(get(connection, id).archiveCauses, [direct(outer.id, 'area', 'Outer')]);
    }
    expectRight(
      restore(connection, {
        target: { id: outer.id },
        revision: row(connection, outer.id).revision,
      }),
    );
    assert.deepEqual(
      descendants.map((id) => row(connection, id)),
      before,
      'restore does not touch them either',
    );
  });
});

test('archive and restore stay available under an archived ancestor', () => {
  withMigrated('archive-under-ancestor', (connection) => {
    const apollo = project(connection, { path: '/work' }, 'Apollo');
    const leaf = note(connection, { id: apollo.id }, 'Leaf');
    archived(connection, apollo.id);

    // An inherited-only note gains an independent cause of its own.
    const added = expectRight(
      archive(connection, { target: { id: leaf.id }, revision: leaf.revision }),
    );
    assert.equal(added.node.revision, leaf.revision + 1);
    assert.deepEqual(added.archiveCauses, [
      direct(leaf.id, 'resource', 'Leaf'),
      direct(apollo.id, 'project', 'Apollo'),
    ]);

    // Restoring it removes its own cause and says truthfully that it is still archived.
    const still = expectRight(
      restore(connection, { target: { id: leaf.id }, revision: added.node.revision }),
    );
    assert.equal(still.node.archived, true);
    assert.equal(still.node.revision, added.node.revision + 1);
    assert.deepEqual(still.archiveCauses, [direct(apollo.id, 'project', 'Apollo')]);
  });
});

test('the root path is refused at the decoder, and an unknown id is not found', () => {
  withMigrated('archive-selectors', (connection) => {
    for (const run of [archive, restore]) {
      const root = toPublicError(
        expectLeft(run(connection, { target: { path: '/' }, revision: 1 })),
      );
      assert.equal(root.code, 'invalid_input');
      assert.equal(root.details['field'], 'target');

      const excess = toPublicError(
        expectLeft(run(connection, { target: { id: 1 }, revision: 1, reason: 'direct' })),
      );
      assert.equal(excess.code, 'invalid_input');

      const missing = toPublicError(
        expectLeft(run(connection, { target: { id: 999_999 }, revision: 1 })),
      );
      assert.equal(missing.code, 'node_not_found');
      assert.deepEqual(missing.details, { field: 'target' });
    }
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM archive_causes'), 0);
  });
});

test('a response that fails its own contract rolls the cause change back', () => {
  withMigrated('archive-response-rollback', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    // Valid JSON array, so storage accepts it; not an array of strings, so the response decoder refuses.
    connection.db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run('[1]', target.id);
    const before = row(connection, target.id);

    const failure = toPublicError(
      expectLeft(archive(connection, { target: { id: target.id }, revision: target.revision })),
    );

    assert.equal(failure.code, 'internal_error');
    assert.deepEqual(causeRows(connection), [], 'the cause insert was rolled back');
    assert.deepEqual(row(connection, target.id), before, 'the revision bump was rolled back');
  });
});
