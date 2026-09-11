import assert from 'node:assert/strict';
import test from 'node:test';

import { TITLE_MAX_CODE_POINTS, SLUG_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import { createNode, toPublicError, type NodeError } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  controlledClock,
  count,
  expectLeft,
  expectRight,
  insertNode,
  one,
  runNodes,
  withMigrated,
} from './support.ts';

/** The seeded root areas, by slug, so no test depends on a generated id. */
const rootId = (connection: Parameters<typeof runNodes>[0], slug: string): number =>
  one<{ id: number }>(
    connection.db,
    'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
    slug,
  ).id;

const create = (
  connection: Parameters<typeof runNodes>[0],
  request: unknown,
  clock = clockAt(1_700_000_000_000),
) => runNodes(connection, createNode(request), clock);

const publicOf = (error: NodeError) => toPublicError(error);

test('a fresh instance creates an area under a seeded root area', () => {
  withMigrated('create-basic', (connection) => {
    const response = expectRight(
      create(connection, { type: 'project', parent: { path: '/work' }, title: 'Quarterly plan' }),
    );

    assert.equal(response.entity.type, 'project');
    assert.equal(response.entity.slug, 'quarterly-plan');
    assert.equal(response.entity.title, 'Quarterly plan');
    assert.equal(response.entity.revision, 1);
    assert.equal(response.entity.parentId, rootId(connection, 'work'));
    assert.equal(response.entity.description, '');
    assert.deepEqual(response.entity.tags, []);
    assert.deepEqual(response.entity.metadata, {});
    assert.deepEqual(response.entity.body, { format: 'markdown', value: '' });
  });
});

test('internal timestamps are stored but never returned', () => {
  withMigrated('create-timestamps', (connection) => {
    const at = 1_700_000_123_456;
    const response = expectRight(
      create(connection, { type: 'area', parent: { path: '/' }, title: 'Reading' }, clockAt(at)),
    );

    const stored = one<{ createdAt: number; updatedAt: number }>(
      connection.db,
      'SELECT created_at AS createdAt, updated_at AS updatedAt FROM nodes WHERE id = ?',
      response.entity.id,
    );
    assert.equal(stored.createdAt, at, 'both timestamps take the one sampled instant');
    assert.equal(stored.updatedAt, at);

    const keys = Object.keys(response.entity).sort();
    assert.deepEqual(keys, [
      'body',
      'description',
      'id',
      'metadata',
      'parentId',
      'revision',
      'slug',
      'tags',
      'title',
      'type',
    ]);
  });
});

test('a title is required, and its limit is measured on the trimmed value', () => {
  withMigrated('create-title', (connection) => {
    for (const title of ['', '   ', '\t\n']) {
      const error = publicOf(
        expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title })),
      );
      assert.equal(error.code, 'invalid_input');
      assert.deepEqual(error.details, { field: 'title', reason: 'title_required' });
    }

    const tooLong = 'a'.repeat(TITLE_MAX_CODE_POINTS + 1);
    const error = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: tooLong })),
    );
    assert.deepEqual(error.details, {
      field: 'title',
      reason: 'title_too_long',
      limit: TITLE_MAX_CODE_POINTS,
    });

    // An explicit slug isolates the title bound from the shorter slug bound a derived address would hit.
    const padded = `   ${'b'.repeat(TITLE_MAX_CODE_POINTS)}   `;
    const saved = expectRight(
      create(connection, { type: 'area', parent: { path: '/' }, title: padded, slug: 'padded' }),
    );
    assert.equal(saved.entity.title, 'b'.repeat(TITLE_MAX_CODE_POINTS));
  });
});

test('an absent title keeps the reason a client can act on', () => {
  withMigrated('create-title-absent', (connection) => {
    const absent = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' } })),
    );
    assert.equal(absent.code, 'invalid_input');
    assert.deepEqual(
      absent.details,
      { field: 'title', reason: 'title_required' },
      'a missing title is a missing title, not an unspecified invalid field',
    );

    // Present but the wrong type is a different problem, and "a title is required" would misdescribe it.
    for (const title of [42, null, { nested: true }, ['a']]) {
      const wrongType = publicOf(
        expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title })),
      );
      assert.deepEqual(
        wrongType.details,
        { field: 'title', reason: 'invalid' },
        JSON.stringify(title),
      );
    }
  });
});

test('a title behind an accessor is not invoked to improve a message', () => {
  withMigrated('create-title-accessor', (connection) => {
    let invoked = false;
    const request = { type: 'area', parent: { path: '/' } };
    Object.defineProperty(request, 'title', {
      enumerable: true,
      get: () => {
        invoked = true;
        return '';
      },
    });

    const error = publicOf(expectLeft(create(connection, request)));
    assert.equal(error.code, 'invalid_input');
    // The decoder reads the property once, which is unavoidable. What must not happen is a *second*
    // invocation during error handling purely to produce a nicer reason.
    assert.deepEqual(
      error.details,
      { field: 'title', reason: 'invalid' },
      'an accessor is treated as unreadable rather than called again while handling a failure',
    );
    assert.equal(invoked, true);
  });
});

test('a title that derives no address is refused as a title problem, not a slug problem', () => {
  withMigrated('create-underivable', (connection) => {
    const error = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: '!!! ???' })),
    );
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, { field: 'title', reason: 'slug_underivable' });
  });
});

test('a title within its own bound can still derive past the slug bound', () => {
  withMigrated('create-slug-too-long', (connection) => {
    // Inside the 200-code-point title bound, past the 100-code-point slug bound.
    const title = 'x'.repeat(SLUG_MAX_CODE_POINTS + 1);
    const error = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title })),
    );
    assert.deepEqual(error.details, {
      field: 'title',
      reason: 'slug_too_long',
      limit: SLUG_MAX_CODE_POINTS,
    });
  });
});

test('slug derivation normalizes the way the frozen contract says it does', () => {
  withMigrated('create-slug-derivation', (connection) => {
    const cases: readonly [string, string][] = [
      ['Reading List', 'reading-list'],
      ['  Spaced   Out  ', 'spaced-out'],
      ['Notes/Ideas', 'notes-ideas'],
      ['Ünicode Wörks', 'ünicode-wörks'],
      ['ＦＵＬＬ Width', 'full-width'],
      ['snake_case_title', 'snake-case-title'],
    ];
    for (const [title, slug] of cases) {
      const response = expectRight(
        create(connection, { type: 'area', parent: { path: '/' }, title }),
      );
      assert.equal(response.entity.slug, slug, `${title} should derive ${slug}`);
    }
  });
});

test('an explicitly submitted slug is kept, and a noncanonical one names the slug field', () => {
  withMigrated('create-explicit-slug', (connection) => {
    const ok = expectRight(
      create(connection, {
        type: 'area',
        parent: { path: '/' },
        title: 'Anything at all',
        slug: 'chosen-address',
      }),
    );
    assert.equal(ok.entity.slug, 'chosen-address');

    const error = publicOf(
      expectLeft(
        create(connection, {
          type: 'area',
          parent: { path: '/' },
          title: 'Anything at all',
          slug: 'Not Canonical',
        }),
      ),
    );
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, { field: 'slug', reason: 'invalid' });
  });
});

test('sibling slugs collide across types, and the root has its own namespace', () => {
  withMigrated('create-collision', (connection) => {
    const work = { path: '/work' };
    expectRight(create(connection, { type: 'project', parent: work, title: 'Shared name' }));

    const sibling = publicOf(
      expectLeft(create(connection, { type: 'area', parent: work, title: 'Shared name' })),
    );
    assert.equal(sibling.code, 'slug_conflict');
    assert.deepEqual(sibling.details, { field: 'slug', slug: 'shared-name', scope: 'sibling' });

    // The same slug is free under a different parent.
    expectRight(
      create(connection, { type: 'project', parent: { path: '/personal' }, title: 'Shared name' }),
    );

    const root = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: 'Work' })),
    );
    assert.equal(root.code, 'slug_conflict');
    assert.deepEqual(root.details, { field: 'slug', slug: 'work', scope: 'root' });
  });
});

test('the parentage matrix is enforced as a product rule', () => {
  withMigrated('create-parentage', (connection) => {
    const work = rootId(connection, 'work');
    const project = expectRight(
      create(connection, { type: 'project', parent: { id: work }, title: 'Holder' }),
    ).entity.id;
    insertNode(connection.db, {
      type: 'resource',
      parentId: project,
      parentType: 'project',
      slug: 'a-note',
    });
    const resource = one<{ id: number }>(
      connection.db,
      'SELECT id FROM nodes WHERE slug = ?',
      'a-note',
    ).id;

    // Areas nest; projects belong under areas.
    expectRight(create(connection, { type: 'area', parent: { id: work }, title: 'Nested area' }));

    const atRoot = publicOf(
      expectLeft(create(connection, { type: 'project', parent: { path: '/' }, title: 'Rootless' })),
    );
    assert.equal(atRoot.code, 'invalid_parent');
    assert.deepEqual(atRoot.details, { field: 'parent', parentType: 'root', childType: 'project' });

    for (const childType of ['area', 'project'] as const) {
      const underProject = publicOf(
        expectLeft(create(connection, { type: childType, parent: { id: project }, title: 'Nope' })),
      );
      assert.equal(underProject.code, 'invalid_parent');
      assert.deepEqual(underProject.details, {
        field: 'parent',
        parentType: 'project',
        childType,
      });

      const underResource = publicOf(
        expectLeft(
          create(connection, { type: childType, parent: { id: resource }, title: 'Nope' }),
        ),
      );
      assert.equal(underResource.code, 'invalid_parent');
      assert.deepEqual(
        underResource.details,
        { field: 'parent', parentType: 'resource', childType },
        'a resource exists and cannot contain anything - that is not the same as it being absent',
      );
    }
  });
});

test('a parent that does not exist is a missing node, named by its field', () => {
  withMigrated('create-missing-parent', (connection) => {
    for (const parent of [{ id: 987_654 }, { path: '/work/nowhere' }]) {
      const error = publicOf(
        expectLeft(create(connection, { type: 'project', parent, title: 'X' })),
      );
      assert.equal(error.code, 'node_not_found');
      assert.deepEqual(error.details, { field: 'parent' });
    }
  });
});

test('bodies are stored canonically and returned in the requested format', () => {
  withMigrated('create-body', (connection) => {
    const markdown = expectRight(
      create(connection, {
        type: 'project',
        parent: { path: '/work' },
        title: 'With body',
        body: { value: '# Heading\n\nSome *text*.' },
      }),
    );
    assert.deepEqual(markdown.entity.body, {
      format: 'markdown',
      value: '# Heading\n\nSome *text*.',
    });

    const stored = one<{ body: string }>(
      connection.db,
      'SELECT body FROM nodes WHERE id = ?',
      markdown.entity.id,
    ).body;
    assert.equal(JSON.parse(stored).type, 'doc', 'storage is always the canonical document');

    const asTipTap = expectRight(
      create(connection, {
        type: 'project',
        parent: { path: '/work' },
        title: 'Tiptap out',
        body: { value: 'plain' },
        format: 'tiptap',
      }),
    );
    assert.equal(asTipTap.entity.body.format, 'tiptap');

    const submittedTipTap = expectRight(
      create(connection, {
        type: 'project',
        parent: { path: '/work' },
        title: 'Tiptap in',
        body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } },
      }),
    );
    assert.deepEqual(submittedTipTap.entity.body, { format: 'markdown', value: '' });
  });
});

test('unsupported submitted content is a content failure, with a location and no content', () => {
  withMigrated('create-unsupported', (connection) => {
    const error = publicOf(
      expectLeft(
        create(connection, {
          type: 'project',
          parent: { path: '/work' },
          title: 'Bad body',
          body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'nonsense' }] } },
        }),
      ),
    );
    assert.equal(error.code, 'unsupported_content');
    assert.equal(error.details['field'], 'body');
    assert.equal(error.details['reason'], 'unsupported_node');
    assert.deepEqual(error.details['path'], [0]);
    assert.equal(
      'element' in error.details,
      false,
      "an unrecognized node name is the caller's input and is never reflected back",
    );
  });
});

test('a failed replay write rolls back the node it was recording', () => {
  withMigrated('create-rollback', (connection) => {
    const nodesBefore = count(connection.db, 'SELECT count(*) AS c FROM nodes');

    // The node insert and the replay record must commit as one fact, so the interesting failure is the
    // one that happens *between* them. A trigger is the only way to reach it deliberately: every value
    // core writes there is valid by construction. Test-only setup, removed immediately afterwards.
    connection.db.exec(
      `CREATE TRIGGER test_block_replay BEFORE INSERT ON creation_replays
       BEGIN SELECT RAISE(ABORT, 'blocked by test'); END`,
    );
    try {
      const error = publicOf(
        expectLeft(
          create(connection, {
            type: 'project',
            parent: { path: '/work' },
            title: 'Doomed',
            idempotencyKey: 'rollback-key',
          }),
        ),
      );
      assert.equal(error.code, 'internal_error');
      assert.deepEqual(error.details, {}, 'an internal failure publishes nothing about itself');
    } finally {
      connection.db.exec('DROP TRIGGER test_block_replay');
    }

    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes'),
      nodesBefore,
      'the entity must not survive a failure to record its replay result',
    );
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM creation_replays'), 0);

    // The same request succeeds once the write can complete, which shows the rollback left no residue.
    expectRight(
      create(connection, {
        type: 'project',
        parent: { path: '/work' },
        title: 'Doomed',
        idempotencyKey: 'rollback-key',
      }),
    );
  });
});

test('a cyclic body is refused before conversion ever sees it', () => {
  withMigrated('create-cyclic-body', (connection) => {
    // Stated for what it is: the decoder's JSON-safety pass rejects this, so the converter is never
    // reached. That is why wrapping the conversion is defence against our own future mistakes rather than
    // a live path - and the stage-aware mapping of an unexpected conversion exception is verified
    // directly in `storage-failures.test.ts`, where such an exception can actually be produced.
    const hostile = { type: 'doc', content: [] as unknown[] };
    hostile.content.push(hostile);

    const error = publicOf(
      expectLeft(
        create(connection, {
          type: 'project',
          parent: { path: '/work' },
          title: 'Hostile body',
          body: { format: 'tiptap', value: hostile },
        }),
      ),
    );
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.details['field'], 'body');
    assert.equal(
      count(connection.db, 'SELECT count(*) AS c FROM nodes WHERE slug = ?', 'hostile-body'),
      0,
    );
  });
});

test('an unusable clock reading fails before anything is written', () => {
  withMigrated('create-bad-clock', (connection) => {
    const before = count(connection.db, 'SELECT count(*) AS c FROM nodes');
    const error = publicOf(
      expectLeft(
        create(
          connection,
          { type: 'project', parent: { path: '/work' }, title: 'No time' },
          controlledClock(() => Number.NaN),
        ),
      ),
    );
    assert.equal(error.code, 'internal_error');
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), before);
  });
});
