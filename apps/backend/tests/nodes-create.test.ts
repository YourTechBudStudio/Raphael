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

    // The complete published surface, named exhaustively. `kind` joined it; `body_text` did not, and
    // must not - it is storage for a search story that has not shipped, and a column that leaks into a
    // response becomes a field someone depends on before anyone decided it was one.
    const keys = Object.keys(response.entity).sort();
    assert.deepEqual(keys, [
      'body',
      'description',
      'id',
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
    assert.deepEqual(atRoot.details, {
      field: 'parent',
      parentType: 'root',
      childType: 'resource',
    });

    // A resource holds nothing at all, and saying so is a different answer from "not found".
    const parent = expectRight(note(connection, { title: 'A note' }));
    const underNote = publicOf(
      expectLeft(note(connection, { parent: { id: parent.entity.id }, title: 'Child' })),
    );
    assert.equal(underNote.code, 'invalid_parent');
    assert.deepEqual(underNote.details, {
      field: 'parent',
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
    assert.equal(bare.details['reason'], 'invalid');
    assert.equal(bare.details['field'], 'kind');

    const unsupported = publicOf(expectLeft(note(connection, { kind: 'sketch', title: 'N' })));
    assert.equal(unsupported.code, 'invalid_input');
    assert.equal(unsupported.details['field'], 'kind');

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
    assert.equal(kinded.details['field'], 'kind');

    assert.equal(count(connection.db, `SELECT count(*) AS c FROM nodes WHERE kind IS NOT NULL`), 0);
  });
});

test('a container missing its title still gets title_required, not a discriminant complaint', () => {
  withMigrated('create-union-title', (connection) => {
    // The union made every non-matching member report the type. This is the regression that would
    // have silently replaced mobile's only specific recovery copy with "the type was wrong".
    const error = publicOf(expectLeft(create(connection, { type: 'area', parent: { path: '/' } })));
    assert.equal(error.code, 'invalid_input');
    assert.deepEqual(error.details, { field: 'title', reason: 'title_required' });

    const tooLong = publicOf(
      expectLeft(
        create(connection, {
          type: 'area',
          parent: { path: '/' },
          title: 'x'.repeat(TITLE_MAX_CODE_POINTS + 1),
        }),
      ),
    );
    assert.deepEqual(tooLong.details, {
      field: 'title',
      reason: 'title_too_long',
      limit: TITLE_MAX_CODE_POINTS,
    });

    // A genuinely unknown type is still reported as the type, because nothing more specific is known.
    const unknown = publicOf(
      expectLeft(create(connection, { type: 'sketch', parent: { path: '/' }, title: 'A' })),
    );
    assert.equal(unknown.details['field'], 'type');
  });
});

/* ------------------------------------------------------------------ derived titles */

test('an omitted note title is derived from the first usable line of the body', () => {
  withMigrated('create-title-from-body', (connection) => {
    const heading = expectRight(
      note(connection, { body: { value: '# API design\n\nRequest contracts' } }),
    );
    assert.equal(heading.entity.title, 'API design');
    assert.equal(heading.entity.slug, 'api-design');

    const sentence = expectRight(
      note(connection, { body: { value: 'Just a sentence.' }, slug: 'sentence' }),
    );
    assert.equal(sentence.entity.title, 'Just a sentence.');

    // Leading blank lines are skipped rather than read as an empty title.
    const padded = expectRight(
      note(connection, { body: { value: '\n\n   \nAfter the gap' }, slug: 'padded' }),
    );
    assert.equal(padded.entity.title, 'After the gap');

    // Code and Mermaid source contribute their text: someone who wrote only a diagram expects to see
    // its first line as the name.
    const mermaid = expectRight(
      note(connection, { body: { value: '```mermaid\ngraph TD\n  a-->b\n```' }, slug: 'diagram' }),
    );
    assert.equal(mermaid.entity.title, 'graph TD');
  });
});

test('the description is the second source, and is only reached when the body has no text', () => {
  withMigrated('create-title-from-description', (connection) => {
    const fromDescription = expectRight(note(connection, { description: 'Weekly review' }));
    assert.equal(fromDescription.entity.title, 'Weekly review');
    assert.equal(fromDescription.entity.slug, 'weekly-review');

    // The body wins when it has anything at all, even with a description present.
    const bodyWins = expectRight(
      note(connection, { body: { value: 'From the body' }, description: 'From the description' }),
    );
    assert.equal(bodyWins.entity.title, 'From the body');
  });
});

test('a note with no usable text anywhere is asked for a title rather than given one', () => {
  withMigrated('create-title-none', (connection) => {
    for (const request of [{}, { body: { value: '' } }, { body: { value: '   \n\n  ' } }]) {
      const error = publicOf(expectLeft(note(connection, request)));
      assert.equal(error.code, 'invalid_input');
      assert.deepEqual(
        error.details,
        { field: 'title', reason: 'title_required' },
        'no generic fallback: an invented name is worse than a prompt',
      );
    }
    assert.equal(
      count(connection.db, `SELECT count(*) AS c FROM nodes WHERE type = 'resource'`),
      0,
    );
  });
});

test('a derived title that cannot produce an address asks for a title, and never invents one', () => {
  withMigrated('create-title-unaddressable', (connection) => {
    // Nothing sluggable in the chosen candidate. `...` is a paragraph of punctuation, so it *is* a
    // candidate - unlike `***`, which is a thematic break and contributes no text at all. The two
    // reach different answers on purpose: one has a name that cannot be addressed, the other has no
    // name to address.
    const underivable = publicOf(expectLeft(note(connection, { body: { value: '...' } })));
    assert.equal(underivable.code, 'invalid_input');
    assert.deepEqual(underivable.details, { field: 'title', reason: 'slug_underivable' });

    const noText = publicOf(expectLeft(note(connection, { body: { value: '***' } })));
    assert.deepEqual(noText.details, { field: 'title', reason: 'title_required' });

    // A 200-code-point title derives a slug past the address limit. Truncating an address the caller
    // never saw would be the convenient answer and the wrong one.
    const long = publicOf(expectLeft(note(connection, { body: { value: 'a'.repeat(250) } })));
    assert.deepEqual(long.details, {
      field: 'title',
      reason: 'slug_too_long',
      limit: SLUG_MAX_CODE_POINTS,
    });

    // It does not fall through to the description looking for a candidate that slugs more
    // conveniently: the note's name must not depend on whether its own first line happens to contain
    // sluggable characters.
    const noFallthrough = publicOf(
      expectLeft(note(connection, { body: { value: '...' }, description: 'Perfectly fine' })),
    );
    assert.deepEqual(noFallthrough.details, { field: 'title', reason: 'slug_underivable' });
  });
});

test('an explicit slug with an omitted title keeps the slug and derives only the name', () => {
  withMigrated('create-explicit-slug', (connection) => {
    const response = expectRight(
      note(connection, { slug: 'chosen-address', body: { value: '# A different name' } }),
    );
    assert.equal(response.entity.slug, 'chosen-address');
    assert.equal(response.entity.title, 'A different name');
  });
});

test('a title is truncated at the limit by code points, not by UTF-16 units', () => {
  withMigrated('create-title-truncation', (connection) => {
    // Astral characters are one code point each and two UTF-16 units. Measuring units would cut this
    // title in half - and could split a surrogate pair into an unpaired one.
    const emoji = '😀'.repeat(TITLE_MAX_CODE_POINTS + 50);
    const response = expectRight(note(connection, { body: { value: emoji }, slug: 'emoji' }));
    assert.equal([...response.entity.title].length, TITLE_MAX_CODE_POINTS);
  });
});
