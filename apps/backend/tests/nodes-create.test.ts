import assert from 'node:assert/strict';
import test from 'node:test';

import { TITLE_MAX_CODE_POINTS } from '@raphael/contracts/nodes';

import { createNode, toPublicError, type NodeError } from '../src/modules/nodes/index.ts';
import {
  clockAt,
  controlledClock,
  count,
  expectLeft,
  expectRight,
  fieldsOf,
  insertNode,
  one,
  runNodes,
  withDerivedSlug,
  withMigrated,
} from './support.ts';

/** The seeded root areas, by slug, so no test depends on a generated id. */
const rootId = (connection: Parameters<typeof runNodes>[0], slug: string): number =>
  one<{ id: number }>(
    connection.db,
    'SELECT id FROM nodes WHERE parent_id IS NULL AND slug = ?',
    slug,
  ).id;

const createRaw = (
  connection: Parameters<typeof runNodes>[0],
  request: unknown,
  clock = clockAt(1_700_000_000_000),
) => runNodes(connection, createNode(request), clock);

/** Creates the way a first-party client does: a missing slug is derived from the title first. */
const create = (
  connection: Parameters<typeof runNodes>[0],
  request: Record<string, unknown>,
  clock = clockAt(1_700_000_000_000),
) => createRaw(connection, withDerivedSlug(request), clock);

const publicOf = (error: NodeError) => ({ ...toPublicError(error), fields: fieldsOf(error) });

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

    // The complete published surface, named exhaustively. `kind` joined it; `body_text` did not, and
    // must not - it is storage for a search story that has not shipped, and a column that leaks into a
    // response becomes a field someone depends on before anyone decided it was one.
    const keys = Object.keys(response.entity).sort();
    assert.deepEqual(keys, [
      'active',
      'archiveCauses',
      'archived',
      'body',
      'description',
      'id',
      'isFavorite',
      'kind',
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
      assert.equal(error.message, 'Title is required.');
    }

    const tooLong = 'a'.repeat(TITLE_MAX_CODE_POINTS + 1);
    const error = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: tooLong })),
    );
    assert.equal(error.message, `Title is longer than ${TITLE_MAX_CODE_POINTS} characters.`);

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
      expectLeft(createRaw(connection, { type: 'area', parent: { path: '/' }, slug: 'a' })),
    );
    assert.equal(absent.code, 'invalid_input');
    assert.equal(
      absent.message,
      'Title is required.',
      'a missing title is a missing title, not an unspecified invalid field',
    );

    // Present but the wrong type is a different problem, and "a title is required" would misdescribe it.
    for (const title of [42, null, { nested: true }, ['a']]) {
      const wrongType = publicOf(
        expectLeft(
          createRaw(connection, { type: 'area', parent: { path: '/' }, title, slug: 'a' }),
        ),
      );
      assert.equal(wrongType.message, 'The title is not valid.', JSON.stringify(title));
    }
  });
});

test('a title behind an accessor is not invoked to improve a message', () => {
  withMigrated('create-title-accessor', (connection) => {
    let invoked = false;
    const request = { type: 'area', parent: { path: '/' }, slug: 'a' };
    Object.defineProperty(request, 'title', {
      enumerable: true,
      get: () => {
        invoked = true;
        return '';
      },
    });

    const error = publicOf(expectLeft(createRaw(connection, request)));
    assert.equal(error.code, 'invalid_input');
    // The decoder reads the property once, which is unavoidable. What must not happen is a *second*
    // invocation during error handling purely to produce a nicer reason.
    assert.equal(
      error.message,
      'The title is not valid.',
      'an accessor is treated as unreadable rather than called again while handling a failure',
    );
    assert.equal(invoked, true);
  });
});

test('a slug is required and must already be canonical; the server never derives one', () => {
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

    const missing = publicOf(
      expectLeft(createRaw(connection, { type: 'area', parent: { path: '/' }, title: 'No slug' })),
    );
    assert.equal(missing.code, 'invalid_input');
    assert.equal(missing.message, 'The slug is not valid.');

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
    assert.equal(error.message, 'The slug is not valid.');
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
    assert.equal(sibling.message, '"shared-name" is already used here.');

    // The same slug is free under a different parent.
    expectRight(
      create(connection, { type: 'project', parent: { path: '/personal' }, title: 'Shared name' }),
    );

    const root = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: 'Work' })),
    );
    assert.equal(root.code, 'slug_conflict');
    assert.equal(root.message, '"work" is already used here.');
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
    assert.deepEqual(atRoot.fields, {
      field: 'parent',
      reason: 'parentage',
      parentType: 'root',
      childType: 'project',
    });

    for (const childType of ['area', 'project'] as const) {
      const underProject = publicOf(
        expectLeft(create(connection, { type: childType, parent: { id: project }, title: 'Nope' })),
      );
      assert.equal(underProject.code, 'invalid_parent');
      assert.deepEqual(underProject.fields, {
        field: 'parent',
        reason: 'parentage',
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
        underResource.fields,
        { field: 'parent', reason: 'parentage', parentType: 'resource', childType },
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
      assert.equal(error.message, 'The parent does not exist.');
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
    assert.equal(error.message, 'The body is not supported: unsupported_node at content[0].');
    assert.equal(
      error.message.includes('nonsense'),
      false,
      "an unrecognized node name is the caller's input and is never reflected back",
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
    assert.equal(error.message, 'The body is not valid.');
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

/* ------------------------------------------------------------------ resources and their kinds */

const note = (
  connection: Parameters<typeof runNodes>[0],
  overrides: Record<string, unknown> = {},
) =>
  create(connection, {
    type: 'resource',
    kind: 'note',
    parent: { path: '/work' },
    ...overrides,
  });

test('a note is created under an area and under a project, and carries its kind', () => {
  withMigrated('create-note-parents', (connection) => {
    const underArea = expectRight(note(connection, { title: 'Under area' }));
    assert.equal(underArea.entity.type, 'resource');
    assert.equal(underArea.entity.kind, 'note');
    assert.equal(underArea.entity.slug, 'under-area');

    const project = expectRight(
      create(connection, { type: 'project', parent: { path: '/work' }, title: 'Holder' }),
    );
    const underProject = expectRight(
      note(connection, { parent: { id: project.entity.id }, title: 'Under project' }),
    );
    assert.equal(underProject.entity.kind, 'note');
    assert.equal(underProject.entity.parentId, project.entity.id);

    // The kind reaches storage, not just the response - the response is assembled from the request,
    // so a test that only read the response would pass with nothing written.
    const stored = one<{ kind: string | null }>(
      connection.db,
      'SELECT kind FROM nodes WHERE id = ?',
      underProject.entity.id,
    );
    assert.equal(stored.kind, 'note');
  });
});

test('the parentage matrix is the full rule now that resources can be created', () => {
  withMigrated('create-note-parentage', (connection) => {
    // Only areas at the root. A note there has no home.
    const atRoot = publicOf(expectLeft(note(connection, { parent: { path: '/' }, title: 'N' })));
    assert.equal(atRoot.code, 'invalid_parent');
    assert.deepEqual(atRoot.fields, {
      field: 'parent',
      reason: 'parentage',
      parentType: 'root',
      childType: 'resource',
    });

    // A resource holds nothing at all, and saying so is a different answer from "not found".
    const parent = expectRight(note(connection, { title: 'A note' }));
    const underNote = publicOf(
      expectLeft(note(connection, { parent: { id: parent.entity.id }, title: 'Child' })),
    );
    assert.equal(underNote.code, 'invalid_parent');
    assert.deepEqual(underNote.fields, {
      field: 'parent',
      reason: 'parentage',
      parentType: 'resource',
      childType: 'resource',
    });

    // A project still cannot hold a container.
    const project = expectRight(
      create(connection, { type: 'project', parent: { path: '/work' }, title: 'Holder' }),
    );
    const areaUnderProject = publicOf(
      expectLeft(
        create(connection, { type: 'area', parent: { id: project.entity.id }, title: 'Nope' }),
      ),
    );
    assert.equal(areaUnderProject.code, 'invalid_parent');
  });
});

test('a bare resource and a kinded container are both refused at the contract', () => {
  withMigrated('create-kind-shape', (connection) => {
    const bare = publicOf(
      expectLeft(create(connection, { type: 'resource', parent: { path: '/work' }, title: 'N' })),
    );
    assert.equal(bare.code, 'invalid_input');
    assert.equal(bare.message, 'The kind is not valid.');

    const unsupported = publicOf(expectLeft(note(connection, { kind: 'sketch', title: 'N' })));
    assert.equal(unsupported.code, 'invalid_input');
    assert.equal(unsupported.message, 'The kind is not valid.');

    // A kind on a container is refused too, and is attributed to the kind rather than to the type -
    // the type is the one thing that request got right.
    const kinded = publicOf(
      expectLeft(
        create(connection, {
          type: 'area',
          kind: 'note',
          parent: { path: '/' },
          title: 'Kinded area',
        }),
      ),
    );
    assert.equal(kinded.code, 'invalid_input');
    assert.equal(kinded.message, 'The kind is not valid.');

    assert.equal(count(connection.db, `SELECT count(*) AS c FROM nodes WHERE kind IS NOT NULL`), 0);
  });
});

test('a container missing its title still gets title_required, not a discriminant complaint', () => {
  withMigrated('create-union-title', (connection) => {
    // The union made every non-matching member report the type. This is the regression that would
    // have silently replaced mobile's only specific recovery copy with "the type was wrong".
    const error = publicOf(expectLeft(create(connection, { type: 'area', parent: { path: '/' } })));
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, 'Title is required.');

    const tooLong = publicOf(
      expectLeft(
        create(connection, {
          type: 'area',
          parent: { path: '/' },
          title: 'x'.repeat(TITLE_MAX_CODE_POINTS + 1),
        }),
      ),
    );
    assert.equal(tooLong.message, `Title is longer than ${TITLE_MAX_CODE_POINTS} characters.`);

    // A genuinely unknown type is still reported as the type, because nothing more specific is known.
    const unknown = publicOf(
      expectLeft(create(connection, { type: 'sketch', parent: { path: '/' }, title: 'A' })),
    );
    assert.equal(unknown.message, 'The type is not valid.');
  });
});

test('a note is not named by the server: an omitted title is refused', () => {
  withMigrated('create-note-title', (connection) => {
    const error = publicOf(
      expectLeft(note(connection, { slug: 'api-design', body: { value: '# API design' } })),
    );
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, 'Title is required.');
    assert.equal(
      count(connection.db, `SELECT count(*) AS c FROM nodes WHERE type = 'resource'`),
      0,
    );
  });
});

/** A cause written straight into storage: these tests ask what creation does, not how archive writes. */
const causeOn = (connection: Parameters<typeof runNodes>[0], id: number) =>
  connection.db
    .prepare(
      `INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, 'user', 'direct', 1)`,
    )
    .run(id);

test('nothing is created under something archived, directly or through a container', () => {
  withMigrated('create-archived-parent', (connection) => {
    const shelf = expectRight(
      create(connection, { type: 'area', parent: { path: '/work' }, title: 'Shelf' }),
    ).entity;
    const inner = expectRight(
      create(connection, { type: 'project', parent: { id: shelf.id }, title: 'Inner' }),
    ).entity;
    causeOn(connection, shelf.id);
    const before = count(connection.db, 'SELECT count(*) AS c FROM nodes');

    for (const [parent, standing] of [
      [{ id: shelf.id }, 'direct'],
      [{ path: '/work/shelf/inner' }, 'inherited'],
    ] as const) {
      const failure = publicOf(
        expectLeft(
          create(connection, { type: 'resource', kind: 'note', parent, title: 'Kept out' }),
        ),
      );
      assert.equal(failure.code, 'node_archived');
      assert.deepEqual(failure.fields, { field: 'parent', standing });
      assert.equal(
        failure.message,
        standing === 'direct'
          ? 'The parent is archived.'
          : 'The parent is inside something archived.',
      );
    }
    assert.equal(count(connection.db, 'SELECT count(*) AS c FROM nodes'), before);
    assert.equal(inner.archived, false, 'it was active when it was created');

    // Parentage is decided before lifecycle: a project under a project is a parentage refusal even
    // when the parent is archived.
    const wrongType = publicOf(
      expectLeft(create(connection, { type: 'project', parent: { id: inner.id }, title: 'X' })),
    );
    assert.equal(wrongType.code, 'invalid_parent');

    // The root is never archived, and an archived sibling still reserves its slug (AC7).
    causeOn(connection, rootId(connection, 'personal'));
    expectRight(create(connection, { type: 'area', parent: { path: '/' }, title: 'Fresh' }));
    const taken = publicOf(
      expectLeft(create(connection, { type: 'area', parent: { path: '/' }, title: 'Personal' })),
    );
    assert.equal(taken.code, 'slug_conflict');
  });
});
