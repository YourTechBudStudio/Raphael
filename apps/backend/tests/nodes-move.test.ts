import assert from 'node:assert/strict';
import test from 'node:test';

import { SLUG_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import {
  createNode,
  getNode,
  getNodePath,
  moveNode,
  searchNodes,
  toPublicError,
} from '../src/modules/nodes/index.ts';
import { clockAt, count, expectLeft, expectRight, one, runNodes, withMigrated } from './support.ts';

/**
 * Relocation, decided and written in one transaction.
 *
 * Every refusal below is also checked for what it did *not* do: the target's row is compared whole
 * before and after, so "atomically rejects" means nothing moved, not merely that an error came back.
 * The cases run in the order the operation evaluates them, which is itself part of the contract.
 */

type Connection = Parameters<typeof runNodes>[0];

const T0 = 1_700_000_000_000;
const AT = T0 + 5_000;
const WORK = 1;
const PERSONAL = 2;

const move = (connection: Connection, request: unknown) =>
  runNodes(connection, moveNode(request), clockAt(AT));

const create = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;

const area = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'area', parent, title });
const project = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'project', parent, title });
const note = (connection: Connection, parent: object, title: string) =>
  create(connection, { type: 'resource', kind: 'note', parent, title, body: { value: '# Body' } });

interface StoredRow {
  readonly parentId: number | null;
  readonly parentType: string | null;
  readonly slug: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly body: string;
}

const stored = (connection: Connection, id: number): StoredRow =>
  one<StoredRow>(
    connection.db,
    `SELECT parent_id AS parentId, parent_type AS parentType, slug, revision,
            updated_at AS updatedAt, title, body
     FROM nodes WHERE id = ?`,
    id,
  );

const refused = (connection: Connection, request: unknown) =>
  toPublicError(expectLeft(move(connection, request)));

const pathOf = (connection: Connection, id: number) =>
  expectRight(runNodes(connection, getNodePath({ target: { id } }))).path;

/** A refusal leaves the row exactly as it was. */
const refusedUnchanged = (connection: Connection, id: number, request: unknown) => {
  const before = stored(connection, id);
  const failure = refused(connection, request);
  assert.deepEqual(stored(connection, id), before, 'a refused move writes nothing');
  return failure;
};

test('a malformed move is refused at the decoder and attributed to the field at fault', () => {
  withMigrated('move-malformed', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');

    const badDestination = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: '/work', slug: 'x' },
    });
    assert.equal(badDestination.code, 'invalid_input');
    assert.deepEqual(badDestination.details, { field: 'destination', reason: 'invalid' });

    const badSlug = refused(connection, {
      target: { id: target.id },
      revision: target.revision,
      destination: { parent: { id: PERSONAL }, slug: 'Not A Slug' },
    });
    assert.deepEqual(badSlug.details, { field: 'destination', reason: 'invalid' });

    const badRevision = refused(connection, {
      target: { id: target.id },
      revision: 0,
      destination: { path: '/personal' },
    });
    assert.deepEqual(badRevision.details, { field: 'revision', reason: 'invalid' });
  });
});

test('a new slug is held to the submission bound, while an existing long slug stays addressable', () => {
  withMigrated('move-slug-bound', (connection) => {
    const long = 'a'.repeat(SLUG_MAX_CODE_POINTS + 1);
    const target = project(connection, { path: '/work' }, 'Apollo');

    const tooLong = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: `/personal/${long}` },
    });
    assert.equal(tooLong.code, 'invalid_input');
    assert.deepEqual(tooLong.details, {
      field: 'destination',
      reason: 'slug_too_long',
      limit: SLUG_MAX_CODE_POINTS,
    });
    assert.equal(tooLong.message, 'The address is longer than the limit.');

    // A container whose stored slug predates today's bound is still a destination by path.
    const legacy = area(connection, { path: '/personal' }, 'Legacy');
    connection.db.prepare('UPDATE nodes SET slug = ? WHERE id = ?').run(long, legacy.id);
    const moved = expectRight(
      move(connection, {
        target: { id: target.id },
        revision: target.revision,
        destination: { path: `/personal/${long}` },
      }),
    ).node;
    assert.equal(moved.parentId, legacy.id);
    assert.equal(moved.slug, 'apollo');
    assert.equal(pathOf(connection, target.id), `/personal/${long}/apollo`);
  });
});

test('an unknown target is not found, by id and by path', () => {
  withMigrated('move-unknown-target', (connection) => {
    for (const target of [{ id: 999 }, { path: '/work/nowhere' }]) {
      const failure = refused(connection, { target, revision: 1, destination: { path: '/work' } });
      assert.equal(failure.code, 'node_not_found');
      assert.deepEqual(failure.details, { field: 'target' });
    }
  });
});

test('a stale revision is reported before anything about the destination', () => {
  withMigrated('move-stale', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const failure = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision + 1,
      // Deliberately nonexistent: the revision is what the caller hears about.
      destination: { parent: { id: 999 } },
    });
    assert.equal(failure.code, 'revision_conflict');
    assert.deepEqual(failure.details, { field: 'revision', currentRevision: target.revision });
  });
});

test('a destination parent that does not exist is not found, in both forms', () => {
  withMigrated('move-missing-destination', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    for (const destination of [{ parent: { id: 999 } }, { path: '/nowhere/x' }]) {
      const failure = refusedUnchanged(connection, target.id, {
        target: { id: target.id },
        revision: target.revision,
        destination,
      });
      assert.equal(failure.code, 'node_not_found', JSON.stringify(destination));
      assert.deepEqual(failure.details, { field: 'destination' });
    }
  });
});

test('a destination path naming a resource is a taken address, even when it is the target', () => {
  withMigrated('move-resource-address', (connection) => {
    const target = note(connection, { path: '/work' }, 'Mine');
    const other = note(connection, { path: '/personal' }, 'Theirs');

    const onOther = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: '/personal/theirs' },
    });
    assert.equal(onOther.code, 'slug_conflict');
    assert.deepEqual(onOther.details, { field: 'destination', slug: 'theirs', scope: 'sibling' });
    assert.equal(stored(connection, other.id).revision, other.revision);

    // A row does not conflict with its own index entry, which is why core refuses this itself.
    const onSelf = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: '/work/mine' },
    });
    assert.equal(onSelf.code, 'slug_conflict');
    assert.deepEqual(onSelf.details, { field: 'destination', slug: 'mine', scope: 'sibling' });
  });
});

test('a container named as its own destination is a cycle, not a type mismatch', () => {
  withMigrated('move-self', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    for (const destination of [
      { path: '/work/apollo' },
      { parent: { id: target.id } },
      // An absent address under itself names itself as the parent.
      { path: '/work/apollo/renamed' },
    ]) {
      const failure = refusedUnchanged(connection, target.id, {
        target: { id: target.id },
        revision: target.revision,
        destination,
      });
      assert.equal(failure.code, 'invalid_parent', JSON.stringify(destination));
      assert.deepEqual(failure.details, {
        field: 'destination',
        reason: 'cycle',
        parentType: 'project',
        childType: 'project',
      });
    }
  });
});

test('an area cannot move under its own descendant', () => {
  withMigrated('move-cycle', (connection) => {
    const outer = area(connection, { path: '/work' }, 'Outer');
    const child = area(connection, { id: outer.id }, 'Child');
    const grandchild = area(connection, { id: child.id }, 'Grandchild');

    const failure = refusedUnchanged(connection, outer.id, {
      target: { id: outer.id },
      revision: outer.revision,
      destination: { parent: { id: grandchild.id } },
    });
    assert.equal(failure.code, 'invalid_parent');
    assert.equal(failure.message, 'Something cannot be moved inside itself.');
    assert.deepEqual(failure.details, {
      field: 'destination',
      reason: 'cycle',
      parentType: 'area',
      childType: 'area',
    });
    assert.equal(stored(connection, grandchild.id).parentId, child.id);
  });
});

test('a parent that cannot hold the target is refused by the parentage rule', () => {
  withMigrated('move-parentage', (connection) => {
    const apollo = project(connection, { path: '/work' }, 'Apollo');
    const gemini = project(connection, { path: '/work' }, 'Gemini');
    const holder = note(connection, { path: '/work' }, 'Holder');

    const cases: readonly [unknown, string, string][] = [
      [{ path: '/' }, 'root', 'Only areas can exist at the root.'],
      [{ parent: { path: '/' } }, 'root', 'Only areas can exist at the root.'],
      [{ path: '/work/gemini' }, 'project', 'That parent cannot contain this kind of entity.'],
      [
        { parent: { id: holder.id } },
        'resource',
        'A note holds nothing, so it cannot be a parent.',
      ],
      // A path through a resource resolves its parent to that resource.
      [{ path: '/work/holder/x' }, 'resource', 'A note holds nothing, so it cannot be a parent.'],
    ];
    for (const [destination, parentType, message] of cases) {
      const failure = refusedUnchanged(connection, apollo.id, {
        target: { id: apollo.id },
        revision: apollo.revision,
        destination,
      });
      assert.equal(failure.code, 'invalid_parent', JSON.stringify(destination));
      assert.equal(failure.message, message);
      assert.deepEqual(failure.details, {
        field: 'destination',
        reason: 'parentage',
        parentType,
        childType: 'project',
      });
    }
    assert.equal(stored(connection, gemini.id).revision, gemini.revision);
  });
});

test('an address already taken in the destination is a slug conflict on the written slug', () => {
  withMigrated('move-collision', (connection) => {
    const target = project(connection, { path: '/work' }, 'Shared');
    const beta = area(connection, { path: '/personal' }, 'Beta');
    area(connection, { id: beta.id }, 'Shared');
    note(connection, { id: beta.id }, 'Taken');

    // The retained slug collides with a container, which the path form treats as the parent - so the
    // collision is reached through the explicit form or through a path to the container above it.
    const retained = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: '/personal/beta' },
    });
    assert.equal(retained.code, 'slug_conflict');
    assert.deepEqual(retained.details, { field: 'slug', slug: 'shared', scope: 'sibling' });

    const renamed = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { parent: { id: beta.id }, slug: 'taken' },
    });
    assert.deepEqual(renamed.details, { field: 'slug', slug: 'taken', scope: 'sibling' });

    // The root has its own namespace.
    const nested = area(connection, { path: '/personal' }, 'Work');
    const atRoot = refusedUnchanged(connection, nested.id, {
      target: { id: nested.id },
      revision: nested.revision,
      destination: { path: '/' },
    });
    assert.deepEqual(atRoot.details, { field: 'slug', slug: 'work', scope: 'root' });
  });
});

test('a move to the current location succeeds without writing, in every spelling', () => {
  withMigrated('move-noop', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const root = area(connection, { path: '/' }, 'Top');

    const cases: readonly [number, unknown][] = [
      [target.id, { path: '/work' }],
      [target.id, { parent: { id: WORK } }],
      [target.id, { parent: { path: '/work' }, slug: 'apollo' }],
      [root.id, { parent: { path: '/' } }],
      [root.id, { path: '/' }],
    ];
    for (const [id, destination] of cases) {
      const before = stored(connection, id);
      const moved = expectRight(
        move(connection, { target: { id }, revision: before.revision, destination }),
      ).node;
      assert.deepEqual(stored(connection, id), before, JSON.stringify(destination));
      assert.equal(moved.revision, before.revision);
      assert.equal(moved.parentId, before.parentId);
      assert.equal(moved.slug, before.slug);
    }
  });
});

test('a relocation with a new slug is one write, in both forms', () => {
  withMigrated('move-rename', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const dest = area(connection, { path: '/personal' }, 'Dest');

    const explicit = expectRight(
      move(connection, {
        target: { id: target.id },
        revision: target.revision,
        destination: { parent: { id: dest.id }, slug: 'artemis' },
      }),
    ).node;
    const first = stored(connection, target.id);
    assert.equal(first.parentId, dest.id);
    assert.equal(first.parentType, 'area');
    assert.equal(first.slug, 'artemis');
    assert.equal(first.revision, target.revision + 1);
    assert.equal(first.updatedAt, AT);
    assert.equal(explicit.revision, target.revision + 1);
    assert.equal(explicit.title, 'Apollo', 'a move never touches the title');

    const byPath = expectRight(
      move(connection, {
        target: { path: '/personal/dest/artemis' },
        revision: explicit.revision,
        destination: { path: '/work/orion' },
      }),
    ).node;
    const after = stored(connection, target.id);
    assert.equal(after.parentId, WORK);
    assert.equal(after.parentType, 'area');
    assert.equal(after.slug, 'orion');
    assert.equal(after.revision, target.revision + 2);
    assert.equal(byPath.revision, after.revision);
    assert.equal(pathOf(connection, target.id), '/work/orion');
  });
});

test('an area can move to the top level', () => {
  withMigrated('move-to-root', (connection) => {
    const target = area(connection, { path: '/work' }, 'Solo');
    const moved = expectRight(
      move(connection, {
        target: { id: target.id },
        revision: target.revision,
        destination: { path: '/' },
      }),
    ).node;
    assert.equal(moved.parentId, null);
    const row = stored(connection, target.id);
    assert.equal(row.parentId, null);
    assert.equal(row.parentType, null);
    assert.equal(pathOf(connection, target.id), '/solo');
  });
});

test('a note can move from a project to an area', () => {
  withMigrated('move-note', (connection) => {
    const apollo = project(connection, { path: '/work' }, 'Apollo');
    const target = note(connection, { id: apollo.id }, 'Plan');
    expectRight(
      move(connection, {
        target: { path: '/work/apollo/plan' },
        revision: target.revision,
        destination: { path: '/personal' },
      }),
    );
    const row = stored(connection, target.id);
    assert.equal(row.parentId, PERSONAL);
    assert.equal(row.parentType, 'area');
  });
});

test('descendants keep their links, bodies and identities, and their paths follow the move', () => {
  withMigrated('move-descendants', (connection) => {
    const a = area(connection, { path: '/work' }, 'A');
    const b = area(connection, { id: a.id }, 'B');
    const c = project(connection, { id: b.id }, 'C');
    const leaf = note(connection, { id: c.id }, 'Leaf');
    const descendants = [b.id, c.id, leaf.id];
    const before = descendants.map((id) => stored(connection, id));
    const aBody = stored(connection, a.id).body;

    expectRight(
      move(connection, {
        target: { id: a.id },
        revision: a.revision,
        destination: { path: '/personal' },
      }),
    );

    assert.deepEqual(
      descendants.map((id) => stored(connection, id)),
      before,
      'no descendant row changed',
    );
    assert.equal(stored(connection, a.id).body, aBody);
    assert.equal(pathOf(connection, leaf.id), '/personal/a/b/c/leaf');
  });
});

test('search follows the moved subtree without re-indexing it', () => {
  withMigrated('move-search', (connection) => {
    const dest = area(connection, { path: '/personal' }, 'Dest');
    const target = note(connection, { path: '/work' }, 'Zanzibar itinerary');
    const indexed = count(connection.db, 'SELECT count(*) AS c FROM nodes_fts');

    expectRight(
      move(connection, {
        target: { id: target.id },
        revision: target.revision,
        destination: { parent: { id: dest.id } },
      }),
    );

    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes_fts'), indexed);
    const found = expectRight(
      runNodes(
        connection,
        searchNodes({ scopes: [{ id: dest.id }], recursive: true, queries: ['zanzibar'] }),
      ),
    );
    assert.deepEqual(
      found.items.map((hit) => hit.node.id),
      [target.id],
    );
    const leftBehind = expectRight(
      runNodes(connection, searchNodes({ scopes: [{ id: WORK }], queries: ['zanzibar'] })),
    );
    assert.equal(leftBehind.items.length, 0);
  });
});

test('a response that fails its own contract rolls the move back', () => {
  withMigrated('move-response-rollback', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    // Valid JSON array, so storage accepts it; not an array of strings, so the response decoder refuses.
    connection.db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run('[1]', target.id);

    const failure = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { path: '/personal' },
    });
    assert.equal(failure.code, 'internal_error');
  });
});

test('corrupt stored ancestry above the destination is an integrity failure, not a move', () => {
  withMigrated('move-corrupt-ancestry', (connection) => {
    const target = project(connection, { path: '/work' }, 'Apollo');
    const x = area(connection, { path: '/personal' }, 'X');
    const y = area(connection, { id: x.id }, 'Y');
    // A two-node cycle above the destination, reachable only through raw SQL.
    connection.db
      .prepare('UPDATE nodes SET parent_id = ?, parent_type = ? WHERE id = ?')
      .run(y.id, 'area', x.id);

    const failure = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { parent: { id: y.id } },
    });
    assert.equal(failure.code, 'internal_error');
    const internal = expectLeft(
      move(connection, {
        target: { id: target.id },
        revision: target.revision,
        destination: { parent: { id: y.id } },
      }),
    );
    assert.equal(internal._tag, 'InternalFailure');
    assert.equal((internal as { detail: string }).detail, 'stored ancestry contains a cycle');
  });
});

/** A cause written straight into storage: these tests ask what a move does, not how archive writes. */
const causeOn = (connection: Connection, id: number, owner = 'user') =>
  connection.db
    .prepare(
      `INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, ?, 'direct', ?)`,
    )
    .run(id, owner, T0);

const causesOf = (connection: Connection, id: number) =>
  expectRight(runNodes(connection, getNode({ target: { id } }))).entity.archiveCauses;

test('something archived by a cause of its own is restored before it moves', () => {
  withMigrated('move-archived-direct', (connection) => {
    const apollo = project(connection, { path: '/work' }, 'Apollo');
    causeOn(connection, apollo.id);

    const failure = refusedUnchanged(connection, apollo.id, {
      target: { id: apollo.id },
      revision: apollo.revision,
      destination: { path: '/personal' },
    });
    assert.equal(failure.code, 'node_archived');
    assert.deepEqual(failure.details, { field: 'target', reason: 'direct' });
  });
});

test('something archived only through a container moves out, and is active afterwards', () => {
  withMigrated('move-archived-inherited', (connection) => {
    const shelf = area(connection, { path: '/work' }, 'Shelf');
    const apollo = project(connection, { id: shelf.id }, 'Apollo');
    const kept = note(connection, { id: apollo.id }, 'Kept');
    const plain = note(connection, { id: apollo.id }, 'Plain');
    const second = note(connection, { id: shelf.id }, 'Second');
    causeOn(connection, shelf.id);
    causeOn(connection, kept.id);

    const moved = expectRight(
      move(connection, {
        target: { id: apollo.id },
        revision: apollo.revision,
        destination: { path: '/personal' },
      }),
    ).node;
    assert.equal(moved.archived, false);
    assert.equal(moved.parentId, PERSONAL);
    assert.deepEqual(causesOf(connection, apollo.id), []);
    // Its subtree came along: the plain note is active, and the independent cause is kept.
    assert.deepEqual(causesOf(connection, plain.id), []);
    assert.deepEqual(
      causesOf(connection, kept.id).map((cause) => cause.origin.id),
      [kept.id],
    );

    // With a new slug, too.
    const renamed = expectRight(
      move(connection, {
        target: { id: second.id },
        revision: second.revision,
        destination: { path: '/personal/rescued' },
      }),
    ).node;
    assert.equal(renamed.slug, 'rescued');
    assert.equal(renamed.archived, false);
  });
});

test('an archived destination is refused, directly or through a container above it', () => {
  withMigrated('move-archived-destination', (connection) => {
    const shelf = area(connection, { path: '/personal' }, 'Shelf');
    const inner = area(connection, { id: shelf.id }, 'Inner');
    const target = project(connection, { path: '/work' }, 'Apollo');
    causeOn(connection, shelf.id);

    for (const [destination, reason] of [
      [{ parent: { id: shelf.id } }, 'direct'],
      [{ path: '/personal/shelf/inner' }, 'inherited'],
      [{ path: '/personal/shelf/inner/renamed' }, 'inherited'],
    ] as const) {
      const failure = refusedUnchanged(connection, target.id, {
        target: { id: target.id },
        revision: target.revision,
        destination,
      });
      assert.equal(failure.code, 'node_archived', JSON.stringify(destination));
      assert.deepEqual(failure.details, { field: 'destination', reason });
    }
    assert.equal(inner.archived, false);
  });
});

test('an inherited-only target "moved" to its current archived parent is refused, not a no-op', () => {
  withMigrated('move-archived-unchanged', (connection) => {
    const shelf = area(connection, { path: '/work' }, 'Shelf');
    const target = note(connection, { id: shelf.id }, 'Stuck');
    causeOn(connection, shelf.id);

    const failure = refusedUnchanged(connection, target.id, {
      target: { id: target.id },
      revision: target.revision,
      destination: { parent: { id: shelf.id } },
    });
    assert.equal(failure.code, 'node_archived');
    assert.deepEqual(failure.details, { field: 'destination', reason: 'direct' });
  });
});

test('lifecycle is decided after revision, destination, cycle and parentage, target first', () => {
  withMigrated('move-archived-order', (connection) => {
    const shelf = area(connection, { path: '/personal' }, 'Shelf');
    const apollo = project(connection, { path: '/work' }, 'Apollo');
    const other = project(connection, { path: '/work' }, 'Other');
    const inside = area(connection, { path: '/work' }, 'Outer');
    causeOn(connection, apollo.id);
    causeOn(connection, shelf.id);
    causeOn(connection, inside.id);

    const at = (destination: object, revision = apollo.revision, id = apollo.id) =>
      refused(connection, { target: { id }, revision, destination });

    assert.equal(at({ parent: { id: shelf.id } }, apollo.revision + 1).code, 'revision_conflict');
    assert.equal(at({ parent: { id: 999_999 } }).code, 'node_not_found');
    assert.equal(
      refused(connection, {
        target: { id: inside.id },
        revision: inside.revision,
        destination: { parent: { id: inside.id } },
      }).details['reason'],
      'cycle',
    );
    assert.equal(at({ parent: { id: other.id } }).code, 'invalid_parent');
    // Both the target and the destination are archived: the target is named.
    assert.deepEqual(at({ parent: { id: shelf.id } }).details, {
      field: 'target',
      reason: 'direct',
    });
  });
});
