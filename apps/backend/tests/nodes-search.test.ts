import assert from 'node:assert/strict';
import test from 'node:test';

import { SEARCH_QUERY_MAX_CODE_POINTS, SEARCH_QUERY_MAX_TERMS } from '@raphael/contracts/nodes';

import {
  createNode,
  getNode,
  searchNodes,
  toPublicError,
  updateNode,
} from '../src/modules/nodes/index.ts';
import { writeTransaction } from '../src/modules/nodes/store.ts';
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

type Connection = Parameters<typeof runNodes>[0];

const search = (connection: Connection, request: unknown) =>
  runNodes(connection, searchNodes(request), clockAt(T0));

const slugsOf = (response: { items: readonly { node: { slug: string } }[] }) =>
  response.items.map((hit) => hit.node.slug);

const create = (connection: Connection, request: Record<string, unknown>) =>
  expectRight(runNodes(connection, createNode(request), clockAt(T0))).entity;

const idOf = (connection: Connection, slug: string): number =>
  one<{ id: number }>(connection.db, 'SELECT id FROM nodes WHERE slug = ?', slug).id;

/**
 * The shared hierarchy every behavior below is run against.
 *
 * `/work` and `/personal` are the seeded root areas. The rest is arranged so that the same words
 * appear under different ancestors and in different fields, which is what lets one fixture answer
 * questions about scope, filter and grammar without each test inventing its own world.
 */
const fixture = (connection: Connection): void => {
  const work = idOf(connection, 'work');
  const personal = idOf(connection, 'personal');

  const raphael = create(connection, {
    type: 'project',
    parent: { id: work },
    title: 'Raphael',
    description: 'auth service',
    tags: ['backend'],
  });
  create(connection, {
    type: 'resource',
    kind: 'note',
    parent: { id: raphael.id },
    title: 'Login flow',
    body: { value: 'auth tokens and credentials' },
    tags: ['backend', 'auth'],
  });
  create(connection, {
    type: 'resource',
    kind: 'note',
    parent: { id: work },
    title: 'Auth notes',
    description: 'credentials',
  });
  create(connection, {
    type: 'resource',
    kind: 'note',
    parent: { id: personal },
    title: 'Bank',
    body: { value: 'credentials for bank' },
    tags: ['finance'],
  });
};

/**
 * Every behavior is asserted against the root-recursive request *and* a node-scoped equivalent.
 *
 * That is how the root-recursive shortcut - which emits no membership clause at all - is shown to
 * agree with the walk on valid data. The two differ only under corrupt cyclic parentage, which no
 * fixture here builds.
 */
const bothScopes = (
  connection: Connection,
  request: Record<string, unknown>,
): readonly [readonly string[], readonly string[]] => {
  const fromRoot = expectRight(
    search(connection, { ...request, scopes: [{ path: '/' }], recursive: true }),
  );
  const fromNodes = expectRight(
    search(connection, {
      ...request,
      scopes: [{ path: '/work' }, { path: '/personal' }],
      recursive: true,
    }),
  );
  return [slugsOf(fromRoot), slugsOf(fromNodes)];
};

/* ------------------------------------------------------------------ relevance */

test('a title match outranks a description match outranks a body match', () => {
  withMigrated('search-rank', (connection) => {
    const work = idOf(connection, 'work');
    // Three rows carrying the same word in a different field, with the other two fields filled to a
    // comparable length. bm25 normalizes by field length, so what is pinned here is the descending
    // order of the weights rather than their values.
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Ledger notes about matters',
      description: 'alpha beta gamma delta',
      body: { value: 'epsilon zeta eta theta' },
    });
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Iota kappa lambda mu',
      description: 'ledger notes about matters',
      body: { value: 'nu xi omicron pi' },
    });
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Rho sigma tau upsilon',
      description: 'phi chi psi omega',
      body: { value: 'ledger notes about matters' },
    });

    const [fromRoot, fromNodes] = bothScopes(connection, { queries: ['ledger'] });
    assert.deepEqual(fromRoot, [
      'ledger-notes-about-matters',
      'iota-kappa-lambda-mu',
      'rho-sigma-tau-upsilon',
    ]);
    assert.deepEqual(fromNodes, fromRoot);
  });
});

test('equal relevance breaks by id ascending, so two requests agree about the boundary', () => {
  withMigrated('search-tiebreak', (connection) => {
    const work = idOf(connection, 'work');
    // Identical text, so nothing but the tie-break can order them.
    const first = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Duplicate subject',
      slug: 'one',
    });
    const second = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Duplicate subject',
      slug: 'two',
    });
    const third = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Duplicate subject',
      slug: 'three',
    });
    assert.ok(first.id < second.id && second.id < third.id);

    const page = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['duplicate'] }),
    );
    assert.deepEqual(
      page.items.map((hit) => hit.node.id),
      [first.id, second.id, third.id],
    );
  });
});

/* ------------------------------------------------------------------ the grammar, over the wire */

test('whitespace means OR, and AND narrows', () => {
  withMigrated('search-grammar-or', (connection) => {
    fixture(connection);

    const [anyOf] = bothScopes(connection, { queries: ['auth tokens'] });
    const [both] = bothScopes(connection, { queries: ['auth AND tokens'] });

    // The hazard the story exists to remove: handed straight to FTS5, `auth tokens` would be an
    // implicit AND and would find strictly less.
    assert.ok(anyOf.length > both.length, `${JSON.stringify(anyOf)} vs ${JSON.stringify(both)}`);
    assert.deepEqual(both, ['login-flow']);
    assert.deepEqual([...anyOf].sort(), ['auth-notes', 'login-flow', 'raphael']);
  });
});

test('a phrase matches only the contiguous words', () => {
  withMigrated('search-grammar-phrase', (connection) => {
    fixture(connection);

    const [contiguous] = bothScopes(connection, { queries: ['"tokens and credentials"'] });
    assert.deepEqual(contiguous, ['login-flow']);

    const [reordered] = bothScopes(connection, { queries: ['"credentials and tokens"'] });
    assert.deepEqual(reordered, []);
  });
});

test('several queries are OR-combined', () => {
  withMigrated('search-grammar-queries', (connection) => {
    fixture(connection);

    const [separate] = bothScopes(connection, { queries: ['tokens', 'finance'] });
    const [oneQuery] = bothScopes(connection, { queries: ['tokens finance'] });
    assert.deepEqual([...separate].sort(), [...oneQuery].sort());
    assert.deepEqual([...separate].sort(), ['login-flow']);
  });
});

test("FTS5's own syntax is dead inside an operand, not merely unmatchable", () => {
  withMigrated('search-grammar-inert', (connection) => {
    const work = idOf(connection, 'work');
    create(connection, { type: 'project', parent: { id: work }, title: 'Auth', slug: 'bare-auth' });
    create(connection, {
      type: 'project',
      parent: { id: work },
      title: 'Authentication',
      slug: 'longer-auth',
    });
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Near login flow',
      slug: 'near-row',
    });
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Login flow',
      slug: 'plain-row',
    });
    create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Column a b',
      slug: 'colon-row',
    });

    // Each case carries a negative witness: the row that *would* have matched if the operator were
    // live. The punctuation is tokenized away and the remaining words match as words.
    const [prefix] = bothScopes(connection, { queries: ['auth*'] });
    assert.deepEqual(
      prefix,
      ['bare-auth'],
      'prefix expansion must be dead: "authentication" is not a hit',
    );

    const [proximity] = bothScopes(connection, { queries: ['"NEAR(login flow)"'] });
    assert.deepEqual(
      proximity,
      ['near-row'],
      'NEAR must be words: the bare "Login flow" row is not a hit',
    );

    // Unquoted, `NEAR(login flow)` is two terms to this grammar, because a term ends at whitespace -
    // so it is an OR of two phrases and finds both rows. That is the parser's doing, not FTS5's.
    const [asTwoTerms] = bothScopes(connection, { queries: ['NEAR(login flow)'] });
    assert.deepEqual([...asTwoTerms].sort(), ['near-row', 'plain-row']);

    const [columnFilter] = bothScopes(connection, { queries: ['a:b'] });
    assert.deepEqual(columnFilter, ['colon-row'], 'a column filter must be words');

    // And none of them errors.
    for (const query of ['-auth', 'auth^', '(auth)', 'auth OR* flow']) {
      assert.ok(
        expectRight(
          search(connection, { scopes: [{ path: '/' }], recursive: true, queries: [query] }),
        ),
        query,
      );
    }
  });
});

test('matching is case- and diacritic-insensitive and is not stemmed', () => {
  withMigrated('search-tokenizer', (connection) => {
    const work = idOf(connection, 'work');
    create(connection, { type: 'project', parent: { id: work }, title: 'Café Résumé' });

    const [folded] = bothScopes(connection, { queries: ['cafe'] });
    assert.deepEqual(folded, ['café-résumé']);
    const [upper] = bothScopes(connection, { queries: ['CAFÉ'] });
    assert.deepEqual(upper, ['café-résumé']);

    // No stemming: the plural is a different token.
    create(connection, { type: 'project', parent: { id: work }, title: 'Tokens' });
    const [singular] = bothScopes(connection, { queries: ['token'] });
    assert.deepEqual(singular, []);
  });
});

/* ------------------------------------------------------------------ scopes */

test('overlapping scopes return each row once, and a scope is never its own result', () => {
  withMigrated('search-scopes-overlap', (connection) => {
    fixture(connection);
    const raphael = idOf(connection, 'raphael');

    const page = expectRight(
      search(connection, {
        scopes: [{ path: '/work' }, { id: raphael }],
        recursive: true,
        queries: ['auth credentials raphael login'],
      }),
    );
    const slugs = slugsOf(page);
    assert.equal(new Set(slugs).size, slugs.length, 'an overlap must not duplicate a row');
    // `/work/raphael` is still a result, because it is a descendant of `/work` - it is excluded only
    // from its own scope's set.
    assert.ok(slugs.includes('raphael'));
    assert.ok(slugs.includes('login-flow'));

    // Searched alone, it is not one of its own results.
    const alone = expectRight(
      search(connection, { scopes: [{ id: raphael }], recursive: true, queries: ['raphael'] }),
    );
    assert.deepEqual(slugsOf(alone), []);
  });
});

test('the default is immediate children, and recursion is what reaches deeper', () => {
  withMigrated('search-scopes-depth', (connection) => {
    fixture(connection);

    // The root's immediate children are the two seeded areas, so nothing below them is in range.
    const shallow = expectRight(
      search(connection, { scopes: [{ path: '/' }], queries: ['credentials auth'] }),
    );
    assert.deepEqual(slugsOf(shallow), []);

    const deep = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['credentials auth'],
      }),
    );
    assert.ok(slugsOf(deep).length > 0);

    // One level down, non-recursively: `/work`'s own children, not `/work/raphael`'s.
    const immediate = expectRight(
      search(connection, { scopes: [{ path: '/work' }], queries: ['credentials auth'] }),
    );
    assert.deepEqual([...slugsOf(immediate)].sort(), ['auth-notes', 'raphael']);
  });
});

test('a scope confines the answer', () => {
  withMigrated('search-scopes-confine', (connection) => {
    fixture(connection);

    const everywhere = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['credentials'] }),
    );
    assert.deepEqual([...slugsOf(everywhere)].sort(), ['auth-notes', 'bank', 'login-flow']);

    const work = expectRight(
      search(connection, {
        scopes: [{ path: '/work' }],
        recursive: true,
        queries: ['credentials'],
      }),
    );
    assert.deepEqual([...slugsOf(work)].sort(), ['auth-notes', 'login-flow']);
  });
});

/* ------------------------------------------------------------------ filters */

test('each filter narrows, and none of them prunes traversal', () => {
  withMigrated('search-filters', (connection) => {
    fixture(connection);
    const query = 'credentials auth raphael authentication';

    const [byType] = bothScopes(connection, { queries: [query], filter: { type: 'resource' } });
    // `/work/raphael/login-flow` is a note whose parent is a project this filter excludes.
    assert.deepEqual([...byType].sort(), ['auth-notes', 'bank', 'login-flow']);

    const [byKind] = bothScopes(connection, { queries: [query], filter: { kind: 'note' } });
    assert.deepEqual([...byKind].sort(), ['auth-notes', 'bank', 'login-flow']);

    const [byTag] = bothScopes(connection, { queries: [query], filter: { tags: 'backend' } });
    assert.deepEqual([...byTag].sort(), ['login-flow', 'raphael']);

    const [combined] = bothScopes(connection, {
      queries: [query],
      filter: { type: 'resource', tags: { $in: ['backend', 'finance'] } },
    });
    assert.deepEqual([...combined].sort(), ['bank', 'login-flow']);

    // The load-bearing one. `/work/raphael/login-flow` is a resource whose *parent* is a project the
    // filter excludes. A filter that pruned the walk would lose it.
    assert.ok(byType.includes('login-flow'));
  });
});

test('a tag matches by normalized equality, and case is significant', () => {
  withMigrated('search-filter-tags', (connection) => {
    fixture(connection);
    const query = 'credentials auth raphael authentication';

    const [padded] = bothScopes(connection, {
      queries: [query],
      filter: { tags: { $in: [' backend '] } },
    });
    assert.deepEqual([...padded].sort(), ['login-flow', 'raphael']);

    const [wrongCase] = bothScopes(connection, { queries: [query], filter: { tags: 'Backend' } });
    assert.deepEqual(wrongCase, []);
  });
});

test('a kind filter does not have to imply a type filter', () => {
  withMigrated('search-filter-kind', (connection) => {
    fixture(connection);
    // A container's kind is NULL and simply does not match, which is the same answer as excluding
    // containers by type - by a shorter route.
    const [notes] = bothScopes(connection, { queries: ['raphael auth'], filter: { kind: 'note' } });
    assert.ok(!notes.includes('raphael'));
  });
});

/* ------------------------------------------------------------------ pagination */

test('hasMore comes from an observed extra row, and the window defaults are the list ones', () => {
  withMigrated('search-paging', (connection) => {
    fixture(connection);
    const request = { scopes: [{ path: '/' }], recursive: true, queries: ['credentials'] };

    const whole = expectRight(search(connection, request));
    assert.equal(whole.items.length, 3);
    assert.equal(whole.skip, 0);
    assert.equal(whole.limit, 50);
    assert.equal(whole.hasMore, false);

    const first = expectRight(search(connection, { ...request, limit: 1 }));
    assert.equal(first.items.length, 1);
    assert.equal(first.hasMore, true);

    const last = expectRight(search(connection, { ...request, limit: 1, skip: 2 }));
    assert.equal(last.items.length, 1);
    assert.equal(last.hasMore, false);

    const past = expectRight(search(connection, { ...request, skip: 99 }));
    assert.deepEqual(past.items, []);
    assert.equal(past.hasMore, false);

    // The three pages are the whole answer, in the same order, with nothing repeated or dropped.
    const paged = [0, 1, 2].flatMap((skip) =>
      slugsOf(expectRight(search(connection, { ...request, limit: 1, skip }))),
    );
    assert.deepEqual(paged, slugsOf(whole));
  });
});

/* ------------------------------------------------------------------ index maintenance */

test('the index follows every write that changes indexed text', () => {
  withMigrated('search-index-writes', (connection) => {
    const work = idOf(connection, 'work');
    const note = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: work },
      title: 'Original heading',
      body: { value: 'original sentence' },
    });

    const find = (word: string) =>
      slugsOf(
        expectRight(
          search(connection, { scopes: [{ path: '/' }], recursive: true, queries: [word] }),
        ),
      );

    assert.deepEqual(find('original'), ['original-heading']);

    // A title-only change re-indexes: the old text stops matching and the new text starts.
    const renamed = expectRight(
      runNodes(
        connection,
        updateNode({
          target: { id: note.id },
          revision: note.revision,
          title: 'Renamed subject',
        }),
        clockAt(T0 + 1),
      ),
    ).entity;
    assert.deepEqual(find('renamed'), ['original-heading']);
    assert.deepEqual(find('heading'), []);
    // The body was untouched, so it still matches - the update did not discard what it did not change.
    assert.deepEqual(find('original'), ['original-heading']);

    // A body change re-indexes the body column.
    expectRight(
      runNodes(
        connection,
        updateNode({
          target: { id: renamed.id },
          revision: renamed.revision,
          body: { value: 'replacement sentence' },
        }),
        clockAt(T0 + 2),
      ),
    );
    assert.deepEqual(find('replacement'), ['original-heading']);
    assert.deepEqual(find('original'), []);
  });
});

test('a row whose body_text is still null is searchable by its title, and gains body matching later', () => {
  withMigrated('search-legacy-body', (connection) => {
    const work = idOf(connection, 'work');
    // The shape the backfill has not reached yet: written directly, with no `body_text`.
    insertNode(connection.db, {
      type: 'resource',
      parentId: work,
      parentType: 'area',
      slug: 'legacy',
      title: 'Legacy heading',
    });
    assert.equal(
      one<{ bodyText: string | null }>(
        connection.db,
        'SELECT body_text AS bodyText FROM nodes WHERE slug = ?',
        'legacy',
      ).bodyText,
      null,
    );

    const find = (word: string) =>
      slugsOf(
        expectRight(
          search(connection, { scopes: [{ path: '/' }], recursive: true, queries: [word] }),
        ),
      );

    // Searchable by title from the moment it exists: FTS5 tokenizes NULL to nothing, so the row is
    // indexed with an empty body column rather than being absent.
    assert.deepEqual(find('legacy'), ['legacy']);
    assert.deepEqual(find('projected'), []);

    // The backfill writes `body_text` alone; the update trigger names that column, so the index
    // follows. No operation had to read the backfill's state.
    connection.db
      .prepare('UPDATE nodes SET body_text = ? WHERE slug = ?')
      .run('projected sentence', 'legacy');
    assert.deepEqual(find('projected'), ['legacy']);
    assert.deepEqual(find('legacy'), ['legacy']);
  });
});

test('indexing is part of the writing transaction, so a rollback un-indexes', () => {
  withMigrated('search-rollback', (connection) => {
    const work = idOf(connection, 'work');

    assert.throws(() =>
      writeTransaction(connection.db, () => {
        insertNode(connection.db, {
          type: 'resource',
          parentId: work,
          parentType: 'area',
          slug: 'doomed',
          title: 'Doomed unrepeatable heading',
        });
        throw new Error('deliberate');
      }),
    );

    const page = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['unrepeatable'],
      }),
    );
    assert.deepEqual(slugsOf(page), []);
  });
});

/* ------------------------------------------------------------------ failures */

test('every published failure is our own vocabulary, and echoes nothing submitted', () => {
  withMigrated('search-failures', (connection) => {
    fixture(connection);
    const base = { scopes: [{ path: '/' }], recursive: true };

    const cases: readonly {
      readonly what: string;
      readonly request: unknown;
      readonly code: string;
      readonly details: Record<string, unknown>;
      readonly secret?: string;
    }[] = [
      {
        what: 'a malformed query',
        request: { ...base, queries: ['topsecretword AND'] },
        code: 'invalid_input',
        details: { field: 'queries', reason: 'query_malformed' },
        secret: 'topsecretword',
      },
      {
        what: 'a query over the length bound',
        request: { ...base, queries: ['z'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1)] },
        code: 'invalid_input',
        details: {
          field: 'queries',
          reason: 'query_too_long',
          limit: SEARCH_QUERY_MAX_CODE_POINTS,
        },
      },
      {
        what: 'a query over the operand bound',
        request: {
          ...base,
          queries: [
            Array.from({ length: SEARCH_QUERY_MAX_TERMS + 1 }, (_, index) => `w${index}`).join(' '),
          ],
        },
        code: 'invalid_input',
        details: {
          field: 'queries',
          reason: 'query_too_many_terms',
          limit: SEARCH_QUERY_MAX_TERMS,
        },
      },
      {
        what: 'an unsupported filter key',
        request: { ...base, queries: ['auth'], filter: { secretkeyname: 1 } },
        code: 'invalid_input',
        details: { field: 'filter', reason: 'filter_unsupported' },
        secret: 'secretkeyname',
      },
      {
        what: 'an unsupported filter operator',
        request: { ...base, queries: ['auth'], filter: { type: { $nin: ['area'] } } },
        code: 'invalid_input',
        details: { field: 'filter', reason: 'filter_unsupported' },
      },
      {
        what: 'a bad filter value',
        request: { ...base, queries: ['auth'], filter: { type: 'folder' } },
        code: 'invalid_input',
        details: { field: 'filter', reason: 'invalid' },
        secret: 'folder',
      },
      {
        what: 'an empty $in',
        request: { ...base, queries: ['auth'], filter: { type: { $in: [] } } },
        code: 'invalid_input',
        details: { field: 'filter', reason: 'invalid' },
      },
      {
        what: 'a bad tag',
        request: { ...base, queries: ['auth'], filter: { tags: '   ' } },
        code: 'invalid_input',
        details: { field: 'filter', reason: 'invalid' },
      },
      {
        what: 'an empty scope list',
        request: { scopes: [], queries: ['auth'] },
        code: 'invalid_input',
        details: { field: 'scopes', reason: 'invalid' },
      },
      {
        what: 'a repeated scope',
        request: { scopes: [{ path: '/work' }, { path: '/work' }], queries: ['auth'] },
        code: 'invalid_input',
        details: { field: 'scopes', reason: 'invalid' },
      },
      {
        what: 'too many queries',
        request: { ...base, queries: Array.from({ length: 11 }, () => 'auth') },
        code: 'invalid_input',
        details: { field: 'queries', reason: 'invalid' },
      },
      {
        what: 'no queries at all',
        request: { ...base, queries: [] },
        code: 'invalid_input',
        details: { field: 'queries', reason: 'invalid' },
      },
      {
        what: 'a non-string query',
        request: { ...base, queries: [42] },
        code: 'invalid_input',
        details: { field: 'queries', reason: 'invalid' },
      },
      {
        what: 'a scope that does not resolve',
        request: { scopes: [{ path: '/work' }, { id: 777_777 }], queries: ['auth'] },
        code: 'node_not_found',
        details: { field: 'scopes', index: 1 },
      },
      {
        what: 'the first scope not resolving',
        request: { scopes: [{ id: 777_777 }], queries: ['auth'] },
        code: 'node_not_found',
        details: { field: 'scopes', index: 0 },
      },
    ];

    for (const scenario of cases) {
      const projected = toPublicError(expectLeft(search(connection, scenario.request)));
      assert.equal(projected.code, scenario.code, scenario.what);
      assert.deepEqual(projected.details, scenario.details, scenario.what);

      const serialized = JSON.stringify(projected);
      if (scenario.secret !== undefined) {
        assert.ok(
          !serialized.includes(scenario.secret),
          `${scenario.what} must not echo what was submitted`,
        );
      }
      // Nothing from a decoder message, the parser, or SQLite reaches a caller.
      assert.doesNotMatch(serialized, /SQLITE|fts5|MATCH|Expected|ParseError/iu, scenario.what);
    }
  });
});

test('a single-selector operation still reports no position', () => {
  withMigrated('search-single-selector', (connection) => {
    const missing = toPublicError(
      expectLeft(runNodes(connection, getNode({ target: { id: 777_777 } }))),
    );
    assert.equal(missing.code, 'node_not_found');
    assert.deepEqual(missing.details, { field: 'target' });
  });
});

test('a search that matches nothing is a successful empty page', () => {
  withMigrated('search-empty', (connection) => {
    fixture(connection);
    const page = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['nothingheresorrymate'],
      }),
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.skip, 0);
  });
});

/** A cause written straight into storage: these tests ask what search does, not how archive writes. */
const causeOn = (connection: Connection, id: number) =>
  connection.db
    .prepare(
      `INSERT INTO archive_causes (node_id, owner, reason, created_at) VALUES (?, 'user', 'direct', ?)`,
    )
    .run(id, T0);

test('an active root area and everything active under it stay searchable while another container is archived', () => {
  withMigrated('search-archived-root-guard', (connection) => {
    const personal = idOf(connection, 'personal');
    const work = idOf(connection, 'work');
    connection.db.prepare(`UPDATE nodes SET title = 'Garden work' WHERE id = ?`).run(work);
    const kept = create(connection, {
      type: 'project',
      parent: { id: work },
      title: 'Garden plan',
    });
    create(connection, { type: 'project', parent: { id: personal }, title: 'Garden trip' });
    causeOn(connection, personal);

    // Shape 1 (root, recursive) and shape 2 (root, immediate children).
    const everything = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['garden'] }),
    );
    assert.deepEqual(
      everything.items.map((hit) => hit.node.id).sort((a, b) => a - b),
      [work, kept.id].sort((a, b) => a - b),
    );
    assert.equal(everything.archivedLeftOut, true);

    const top = expectRight(search(connection, { scopes: [{ path: '/' }], queries: ['garden'] }));
    assert.deepEqual(slugsOf(top), ['work']);
    assert.equal(top.archivedLeftOut, false, 'the archived match is not an immediate child');
  });
});

test('archived matches are excluded by default, in every shape, and marked on request', () => {
  withMigrated('search-archived-shapes', (connection) => {
    const work = idOf(connection, 'work');
    const shelf = create(connection, { type: 'area', parent: { id: work }, title: 'Comet shelf' });
    const inner = create(connection, { type: 'project', parent: { id: shelf.id }, title: 'Comet' });
    const buried = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: inner.id },
      title: 'Comet notes',
    });
    const live = create(connection, { type: 'project', parent: { id: work }, title: 'Live' });
    const hidden = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: live.id },
      title: 'Comet sighting',
    });
    const visible = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: live.id },
      title: 'Comet tail',
    });
    causeOn(connection, shelf.id);
    causeOn(connection, hidden.id);

    const ids = (request: Record<string, unknown>) =>
      expectRight(search(connection, { queries: ['comet'], ...request }))
        .items.map((hit) => hit.node.id)
        .sort((a, b) => a - b);

    assert.deepEqual(ids({ scopes: [{ path: '/' }], recursive: true }), [visible.id]);
    assert.deepEqual(ids({ scopes: [{ id: live.id }] }), [visible.id]);
    assert.deepEqual(ids({ scopes: [{ id: work }], recursive: true }), [visible.id]);
    // A scope inside the archived subtree: empty by default, everything on request.
    assert.deepEqual(ids({ scopes: [{ id: shelf.id }], recursive: true }), []);
    assert.deepEqual(ids({ scopes: [{ id: shelf.id }], recursive: true, includeArchived: true }), [
      inner.id,
      buried.id,
    ]);

    const included = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['comet'],
        includeArchived: true,
      }),
    );
    assert.deepEqual(
      Object.fromEntries(included.items.map((hit) => [hit.node.id, hit.node.archived])),
      {
        [shelf.id]: true,
        [inner.id]: true,
        [buried.id]: true,
        [hidden.id]: true,
        [visible.id]: false,
      },
    );
    assert.equal(included.archivedLeftOut, false, 'nothing is left out when it was asked for');
  });
});

test('archivedLeftOut is about the whole match set, within the same scope and filter', () => {
  withMigrated('search-archived-left-out', (connection) => {
    const work = idOf(connection, 'work');
    const personal = idOf(connection, 'personal');
    const holder = create(connection, { type: 'project', parent: { id: work }, title: 'Holder' });
    const note = (title: string, parent = holder.id) =>
      create(connection, { type: 'resource', kind: 'note', parent: { id: parent }, title });

    // Nothing archived matches.
    note('Nebula one');
    const plain = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['nebula'] }),
    );
    assert.equal(plain.archivedLeftOut, false);

    // Only an archived node matches.
    const lonely = note('Quasar');
    causeOn(connection, lonely.id);
    const only = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['quasar'] }),
    );
    assert.deepEqual(only.items, []);
    assert.equal(only.archivedLeftOut, true);

    // An archived match that would rank outside the returned window still counts. Many strong active
    // matches outrank a weak archived one (a description match loses to title matches).
    for (let index = 0; index < 5; index += 1) note(`Pulsar ${index}`);
    const weak = create(connection, {
      type: 'resource',
      kind: 'note',
      parent: { id: holder.id },
      title: 'Faint',
      description: 'mentions pulsar once',
    });
    causeOn(connection, weak.id);
    const windowed = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['pulsar'],
        limit: 2,
      }),
    );
    assert.equal(windowed.items.length, 2);
    assert.equal(windowed.hasMore, true);
    assert.equal(windowed.archivedLeftOut, true);
    const beyond = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['pulsar'],
        skip: 1,
        limit: 1,
        includeArchived: true,
      }),
    );
    assert.equal(beyond.items[0]?.node.archived, false, 'the archived match is not near the top');

    // An archived match outside the scope, or outside the filter, is not "left out".
    const elsewhere = create(connection, {
      type: 'project',
      parent: { id: personal },
      title: 'Nebula two',
    });
    causeOn(connection, elsewhere.id);
    const scoped = expectRight(
      search(connection, { scopes: [{ id: work }], recursive: true, queries: ['nebula'] }),
    );
    assert.equal(scoped.archivedLeftOut, false);
    const filtered = expectRight(
      search(connection, {
        scopes: [{ path: '/' }],
        recursive: true,
        queries: ['nebula'],
        filter: { type: 'resource' },
      }),
    );
    assert.equal(filtered.archivedLeftOut, false);
    const unfiltered = expectRight(
      search(connection, { scopes: [{ path: '/' }], recursive: true, queries: ['nebula'] }),
    );
    assert.equal(unfiltered.archivedLeftOut, true);
  });
});
