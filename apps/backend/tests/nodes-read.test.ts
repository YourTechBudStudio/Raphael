import assert from 'node:assert/strict';
import test from 'node:test';

import { createNode, getNode, listNodes, toPublicError } from '../src/modules/nodes/index.ts';
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

test('a stored kind that contradicts its type is an integrity failure on read and on list', () => {
  withMigrated('read-corrupt-kind', (connection) => {
    const project = seed(connection);
    const note = expectRight(
      runNodes(
        connection,
        createNode({
          type: 'resource',
          kind: 'note',
          parent: { id: project.id },
          title: 'A note',
        }),
        clockAt(T0),
      ),
    ).entity;

    // The `0002` constraint is what stops these rows being written, so constructing one means turning
    // it off. That is the whole point: this projection defends the case where something bypassed the
    // constraint, and without a bypass there is no way to find out whether it actually does.
    //
    // Enforcement is restored before any read, so the operations run against a database whose rules
    // are the real ones - only its contents are wrong.
    const corrupt = (sql: string, ...params: unknown[]): void => {
      connection.db.pragma('ignore_check_constraints = ON');
      try {
        connection.db.prepare(sql).run(...params);
      } finally {
        connection.db.pragma('ignore_check_constraints = OFF');
      }
    };

    const cases = [
      {
        what: 'a resource with no kind at all',
        apply: () => corrupt('UPDATE nodes SET kind = NULL WHERE id = ?', note.id),
        id: note.id,
      },
      {
        what: 'a resource carrying a kind core does not admit',
        apply: () => corrupt('UPDATE nodes SET kind = ? WHERE id = ?', 'sketch', note.id),
        id: note.id,
      },
      {
        what: 'a container carrying a kind',
        apply: () => corrupt('UPDATE nodes SET kind = ? WHERE id = ?', 'note', project.id),
        id: project.id,
      },
    ];

    for (const scenario of cases) {
      scenario.apply();

      // Get refuses rather than answering with a plausible entity.
      const read = toPublicError(
        expectLeft(runNodes(connection, getNode({ target: { id: scenario.id } }))),
      );
      assert.equal(read.code, 'internal_error', scenario.what);
      assert.deepEqual(read.details, {}, 'nothing about the malformed row reaches the caller');

      // List refuses too, rather than silently dropping the row or returning a partial page. The
      // scope is chosen so the malformed row is inside the page being projected - a listing that
      // never selected it would pass this assertion without exercising anything.
      const scope = scenario.id === project.id ? { path: '/work' } : { id: project.id };
      const page = runNodes(connection, listNodes({ parent: scope }));
      const listed = toPublicError(expectLeft(page));
      assert.equal(listed.code, 'internal_error', scenario.what);
      assert.deepEqual(listed.details, {});

      // And nothing was repaired on the way past.
      const after = one<{ kind: string | null }>(
        connection.db,
        'SELECT kind FROM nodes WHERE id = ?',
        scenario.id,
      );
      const expected =
        scenario.what === 'a resource with no kind at all'
          ? null
          : scenario.what === 'a container carrying a kind'
            ? 'note'
            : 'sketch';
      assert.equal(after.kind, expected, `${scenario.what}: a read must not rewrite what it found`);
    }

    // Restoring the row restores the operation, which is what shows the refusals above were about
    // this row's contents rather than something sticky in the connection.
    corrupt('UPDATE nodes SET kind = ? WHERE id = ?', 'note', note.id);
    corrupt('UPDATE nodes SET kind = NULL WHERE id = ?', project.id);
    const recovered = expectRight(runNodes(connection, getNode({ target: { id: note.id } })));
    assert.equal(recovered.entity.kind, 'note');
  });
});
