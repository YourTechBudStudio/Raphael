import assert from 'node:assert/strict';
import test from 'node:test';

import { TAGS_MAX_COUNT } from '@raphael/contracts/nodes';

import {
  RevisionConflict,
  createNode,
  getNode,
  toPublicError,
  updateNode,
} from '../src/modules/nodes/index.ts';
import {
  EMPTY_BODY,
  clockAt,
  controlledClock,
  expectLeft,
  expectRight,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

/**
 * The revision-guarded write.
 *
 * Two properties are asserted more insistently than the rest, because they are what "safely" means in
 * this story. A refused update leaves the row exactly as it was - not mostly, not except for the
 * timestamp - and a stale revision is refused *before* any content is looked at, so a caller whose
 * write is already lost is told that rather than being told their body was unacceptable.
 */

type Connection = Parameters<typeof runNodes>[0];

const AT = 1_700_000_000_000;

const update = (connection: Connection, request: unknown, clock = clockAt(AT)) =>
  runNodes(connection, updateNode(request), clock);

const create = (connection: Connection, request: unknown) =>
  expectRight(runNodes(connection, createNode(request))).entity;

/** Every stored column an update can touch, plus the two it must not invent. */
interface StoredRow {
  readonly title: string;
  readonly description: string;
  readonly slug: string;
  readonly revision: number;
  readonly tags: string;
  readonly body: string;
  readonly bodyText: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const stored = (connection: Connection, id: number): StoredRow =>
  one<StoredRow>(
    connection.db,
    `SELECT title, description, slug, revision, tags, body,
            body_text AS bodyText, created_at AS createdAt, updated_at AS updatedAt
     FROM nodes WHERE id = ?`,
    id,
  );

const note = (connection: Connection, title: string, extra: object = {}) =>
  create(connection, {
    type: 'resource',
    kind: 'note',
    parent: { path: '/work' },
    title,
    ...extra,
  });

test('a title-only update changes the title, the revision and the timestamp, and nothing else', () => {
  withMigrated('update-title', (connection) => {
    const created = note(connection, 'Draft', {
      description: 'A note',
      body: { value: '# Heading' },
    });
    const before = stored(connection, created.id);

    const at = 1_700_000_999_000;
    const response = expectRight(
      update(
        connection,
        { target: { id: created.id }, revision: created.revision, title: 'Renamed' },
        clockAt(at),
      ),
    );

    assert.equal(response.entity.title, 'Renamed');
    assert.equal(response.entity.revision, 2);

    const after = stored(connection, created.id);
    assert.equal(after.title, 'Renamed');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.updatedAt, at, 'updated_at takes the instant the row was written');
    assert.equal(after.createdAt, before.createdAt, 'created_at is not touched');
    assert.equal(after.description, before.description);
    assert.equal(after.slug, before.slug, 'a title change never touches the slug');
    assert.equal(after.body, before.body);
    assert.equal(after.bodyText, before.bodyText, 'body_text is re-derived only for a new body');

    // The operation's own answer and a later read agree, which is the whole of "returns the resulting
    // entity": there is no state the response describes that a subsequent read would contradict.
    const fetched = expectRight(runNodes(connection, getNode({ target: { id: created.id } })));
    assert.deepEqual(response.entity, fetched.entity);
  });
});

test('an omitted field is left alone and a supplied empty one clears', () => {
  withMigrated('update-clear', (connection) => {
    const created = note(connection, 'Draft', { description: 'Explains the thing' });

    const response = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        description: '',
      }),
    );

    assert.equal(response.entity.description, '');
    assert.equal(response.entity.title, 'Draft', 'an omitted title is unchanged');
    assert.equal(stored(connection, created.id).description, '');
  });
});

test('a slug change moves the address, and re-submitting the current one is accepted', () => {
  withMigrated('update-slug', (connection) => {
    const created = note(connection, 'Draft');

    const moved = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        slug: 'final-draft',
      }),
    );
    assert.equal(moved.entity.slug, 'final-draft');

    const fetched = expectRight(
      runNodes(connection, getNode({ target: { path: '/work/final-draft' } })),
    );
    assert.equal(fetched.entity.id, created.id);

    // A row does not conflict with its own index entry, so this needs no self-exclusion anywhere.
    const same = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: moved.entity.revision,
        slug: 'final-draft',
      }),
    );
    assert.equal(same.entity.slug, 'final-draft');
    assert.equal(same.entity.revision, 3, 'a value equal to the stored one is still a write');
  });
});

test('a new body is stored canonically and its plain text re-derived', () => {
  withMigrated('update-body', (connection) => {
    const created = note(connection, 'Draft', { body: { value: 'original text' } });

    const response = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        body: { value: '# Replacement' },
      }),
    );

    assert.deepEqual(response.entity.body, { format: 'markdown', value: '# Replacement' });
    const after = stored(connection, created.id);
    assert.equal(after.bodyText, 'Replacement');
    assert.equal(after.body.includes('heading'), true);
  });
});

test('an explicitly empty body clears to the canonical empty document', () => {
  withMigrated('update-body-empty', (connection) => {
    const created = note(connection, 'Draft', { body: { value: 'something' } });

    const response = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        body: { value: '' },
      }),
    );

    assert.deepEqual(response.entity.body, { format: 'markdown', value: '' });
    const after = stored(connection, created.id);
    assert.equal(after.body, EMPTY_BODY, 'the same document the seed migration writes');
    assert.equal(after.bodyText, '', 'read and found empty, which is not the same as underived');
  });
});

test('a TipTap body is accepted, and the response format is the one that was asked for', () => {
  withMigrated('update-body-tiptap', (connection) => {
    const created = note(connection, 'Draft');

    const response = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        body: {
          format: 'tiptap',
          value: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Written' }] }],
          },
        },
        format: 'tiptap',
      }),
    );

    assert.equal(response.entity.body.format, 'tiptap');
    assert.equal(stored(connection, created.id).bodyText, 'Written');
  });
});

test('an unsupported body is refused and the entity is untouched', () => {
  withMigrated('update-body-unsupported', (connection) => {
    const created = note(connection, 'Draft');
    const before = stored(connection, created.id);

    const error = expectLeft(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        title: 'Renamed',
        body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'unknown-block' }] } },
      }),
    );

    assert.equal(toPublicError(error).code, 'unsupported_content');
    assert.deepEqual(stored(connection, created.id), before, 'an invalid edit changes nothing');
  });
});

test('a combined update is one fact: a colliding slug leaves the title unchanged', () => {
  withMigrated('update-atomic', (connection) => {
    note(connection, 'Alpha');
    const beta = note(connection, 'Beta');
    const before = stored(connection, beta.id);

    const error = expectLeft(
      update(connection, {
        target: { id: beta.id },
        revision: beta.revision,
        title: 'Renamed',
        slug: 'alpha',
      }),
    );

    const published = toPublicError(error);
    assert.equal(published.code, 'slug_conflict');
    assert.equal(published.details['scope'], 'sibling');
    assert.deepEqual(stored(connection, beta.id), before);
  });
});

test('a stale revision is refused, and refused before any content is converted', () => {
  withMigrated('update-stale', (connection) => {
    const created = note(connection, 'Draft');
    const current = expectRight(
      update(connection, { target: { id: created.id }, revision: created.revision, title: 'One' }),
    ).entity;
    const before = stored(connection, created.id);

    const error = expectLeft(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        title: 'Two',
        // Unacceptable content, submitted against a revision that is already gone. The conflict is the
        // more useful answer: the caller has to re-read and rebuild regardless of what their body said.
        body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'unknown-block' }] } },
      }),
    );

    assert.equal(error._tag, 'RevisionConflict');
    const published = toPublicError(error);
    assert.equal(published.code, 'revision_conflict');
    assert.deepEqual(published.details, { field: 'revision', currentRevision: current.revision });
    assert.deepEqual(stored(connection, created.id), before);
  });
});

test('a revision ahead of the row conflicts too', () => {
  withMigrated('update-ahead', (connection) => {
    const created = note(connection, 'Draft');

    const error = expectLeft(
      update(connection, {
        target: { id: created.id },
        revision: created.revision + 1,
        title: 'Renamed',
      }),
    );

    // Nobody can legitimately hold a revision the row has not reached. Without this precondition the
    // compare-and-set could match a row the operation never read, and the response would describe a
    // state nothing inspected.
    assert.equal(error._tag, 'RevisionConflict');
    assert.deepEqual(toPublicError(error).details, {
      field: 'revision',
      currentRevision: created.revision,
    });
  });
});

test('a revision the row only reaches later is refused by the read, not applied by the guard', () => {
  withMigrated('update-precondition', (connection) => {
    const created = note(connection, 'Draft');

    // This is the case the read-time precondition exists for, and the only one that distinguishes it
    // from the write guard. The caller claims revision 5 against a row at 1; the row then reaches 5
    // before the write. The compare-and-set alone would match, and the response would be assembled from
    // the row read at revision 1 - describing a state nobody inspected, with tags computed from tags
    // that are no longer there.
    let samples = 0;
    const clock = controlledClock(() => {
      samples += 1;
      connection.db.prepare('UPDATE nodes SET revision = 5 WHERE id = ?').run(created.id);
      return AT;
    });

    const error = expectLeft(
      update(connection, { target: { id: created.id }, revision: 5, title: 'Renamed' }, clock),
    );

    assert.equal(error._tag, 'RevisionConflict');
    assert.deepEqual(toPublicError(error).details, { field: 'revision', currentRevision: 1 });
    assert.equal(samples, 0, 'refused before the write transaction was ever opened');
    assert.equal(stored(connection, created.id).title, 'Draft');
  });
});

test('the write guard is the verdict when the row moves between the read and the write', () => {
  withMigrated('update-concurrent', (connection) => {
    const created = note(connection, 'Draft');

    // The clock is the seam. `commit` samples it as its first statement, inside the write transaction
    // and after the read transaction has closed, so a bump performed here lands exactly between the two
    // - the one interleaving the write guard exists for.
    //
    // This reproduces that interleaving; it is not two clients racing. `store.ts` argues that a
    // transaction body is fully synchronous precisely so that no other writer can interleave, and the
    // injected statement runs on the same connection inside the same transaction.
    let samples = 0;
    const clock = controlledClock(() => {
      samples += 1;
      if (samples === 1) {
        connection.db.prepare('UPDATE nodes SET revision = 7 WHERE id = ?').run(created.id);
      }
      return AT;
    });

    const error = expectLeft(
      update(
        connection,
        { target: { id: created.id }, revision: created.revision, title: 'Renamed' },
        clock,
      ),
    );

    assert.equal(samples, 1, 'the operation sampled the clock exactly once, inside the commit');
    assert.equal(error._tag, 'RevisionConflict');
    // The bumped value, read back by the guard's own re-select. Asserting the row afterwards would be
    // asserting the rollback, which the atomicity test above already covers.
    assert.deepEqual(toPublicError(error).details, { field: 'revision', currentRevision: 7 });
  });
});

test('a target that disappears between the read and the write is a missing target', () => {
  withMigrated('update-vanished', (connection) => {
    const created = note(connection, 'Draft');

    // Unreachable in production until there is an operation that removes rows (story #8). The same
    // clock seam reaches it at no cost, so the branch is exercised rather than merely reasoned about.
    let samples = 0;
    const clock = controlledClock(() => {
      samples += 1;
      if (samples === 1) {
        connection.db.prepare('DELETE FROM nodes WHERE id = ?').run(created.id);
      }
      return AT;
    });

    const error = expectLeft(
      update(
        connection,
        { target: { id: created.id }, revision: created.revision, title: 'Renamed' },
        clock,
      ),
    );

    assert.equal(samples, 1, 'the row vanished inside the commit, not before the read');
    assert.equal(error._tag, 'NodeNotFound');
    assert.deepEqual(toPublicError(error).details, { field: 'target' });
  });
});

test('what an update cannot change is refused as the request, not attributed to a field', () => {
  withMigrated('update-unpatchable', (connection) => {
    const created = note(connection, 'Draft');
    const base = { target: { id: created.id }, revision: created.revision };

    for (const [field, value] of [
      ['parentId', 1],
      ['parent', { path: '/personal' }],
      ['id', 4],
      ['type', 'area'],
      ['kind', 'note'],
      ['metadata', { a: 1 }],
    ] as const) {
      const error = expectLeft(update(connection, { ...base, title: 'Renamed', [field]: value }));
      const published = toPublicError(error);
      assert.equal(published.code, 'invalid_input', field);
      // None of these is in `UPDATE_FIELDS`, so there is no field to name - and naming one would point
      // the caller at something that was not at fault.
      assert.deepEqual(published.details, { reason: 'invalid' }, field);
    }
  });
});

test('an envelope that changes nothing is refused as the request as a whole', () => {
  withMigrated('update-empty', (connection) => {
    const created = note(connection, 'Draft');

    const error = expectLeft(
      update(connection, { target: { id: created.id }, revision: created.revision }),
    );

    assert.deepEqual(toPublicError(error).details, { reason: 'invalid' });
  });
});

test('tags are a set: additions append in submitted order and removals drop', () => {
  withMigrated('update-tags', (connection) => {
    const created = note(connection, 'Draft', { tags: ['alpha', 'beta'] });

    const added = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        addTags: ['delta', 'gamma'],
      }),
    ).entity;
    assert.deepEqual(
      added.tags,
      ['alpha', 'beta', 'delta', 'gamma'],
      'stored order, then submitted',
    );

    const removed = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: added.revision,
        removeTags: ['beta'],
      }),
    ).entity;
    assert.deepEqual(removed.tags, ['alpha', 'delta', 'gamma']);
  });
});

test('adding a present tag and removing an absent one are no-ops that are still writes', () => {
  withMigrated('update-tags-noop', (connection) => {
    const created = note(connection, 'Draft', { tags: ['alpha'] });

    const response = expectRight(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        addTags: ['alpha'],
        removeTags: ['nothing-here'],
      }),
    ).entity;

    assert.deepEqual(response.tags, ['alpha']);
    assert.equal(response.revision, 2, 'the caller asked for a resulting state and got it');
  });
});

test('the tag bound is checked on the resulting set, and an overflow changes nothing', () => {
  withMigrated('update-tags-overflow', (connection) => {
    const full = Array.from({ length: TAGS_MAX_COUNT }, (_, index) => `t${index}`);
    const created = note(connection, 'Draft', { tags: full });
    const before = stored(connection, created.id);

    const error = expectLeft(
      update(connection, {
        target: { id: created.id },
        revision: created.revision,
        addTags: ['one-too-many'],
      }),
    );

    const published = toPublicError(error);
    assert.equal(published.code, 'invalid_input');
    // Attributed to `tags` rather than `addTags`: the overflow is caused by the resulting set, most of
    // which the caller did not submit.
    assert.deepEqual(published.details, {
      field: 'tags',
      reason: 'tags_too_many',
      limit: TAGS_MAX_COUNT,
    });
    assert.deepEqual(stored(connection, created.id), before);
  });
});

test('a container and a note accept the same envelope', () => {
  withMigrated('update-container', (connection) => {
    const project = create(connection, {
      type: 'project',
      parent: { path: '/work' },
      title: 'Migration',
    });

    const response = expectRight(
      update(connection, {
        target: { id: project.id },
        revision: project.revision,
        title: 'Migration, phase two',
        addTags: ['planning'],
      }),
    ).entity;

    assert.equal(response.type, 'project');
    assert.equal(response.kind, null);
    assert.equal(response.title, 'Migration, phase two');
    assert.deepEqual(response.tags, ['planning']);
  });
});

test('an update against a target that does not exist names the target', () => {
  withMigrated('update-missing', (connection) => {
    const error = expectLeft(
      update(connection, { target: { id: 999_999 }, revision: 1, title: 'Renamed' }),
    );

    assert.equal(toPublicError(error).code, 'node_not_found');
    assert.deepEqual(toPublicError(error).details, { field: 'target' });
  });
});

test('a revision conflict publishes the revision to re-read, and nothing else', () => {
  const published = toPublicError(new RevisionConflict({ current: 4 }));
  assert.equal(published.code, 'revision_conflict');
  assert.deepEqual(published.details, { field: 'revision', currentRevision: 4 });
});
