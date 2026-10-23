import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { NODE_ROUTES } from '@raphael/contracts/nodes';

import { runCli, stubServer, type Ran, type StubRequest } from './support/cli.ts';
import { goldenSurface } from './support/golden.ts';

/**
 * What a successful command prints, and the refusals about the body that are decided before sending.
 *
 * Every row layout, state word, footer, empty-result line, write layout and body warning is pinned
 * here against a stub that answers each route as this release's server would. The stub records what
 * was asked, so a case can also hold the CLI to asking for paths.
 */

/** Not `output`: the repository ignores every directory of that name. */
const output = goldenSurface('printed');

after(() => {
  assert.deepEqual(output.strays(), []);
});

const UPDATED_AT = '2026-10-19T10:42:07.123Z';

type Item = Record<string, unknown>;

const summary = (id: number, path: string, extra: Item = {}): Item => ({
  id,
  type: 'project',
  kind: null,
  parentId: 1,
  slug: path.split('/').at(-1),
  revision: 3,
  title: `Item ${id}`,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  updatedAt: UPDATED_AT,
  path,
  ...extra,
});

const note = (id: number, path: string, extra: Item = {}): Item =>
  summary(id, path, { type: 'resource', kind: 'note', ...extra });

const entity = (item: Item, extra: Item = {}): Item => ({
  ...item,
  body: { format: 'markdown', value: '# Heading\n\nSome text.' },
  metadata: {},
  archiveCauses: [],
  ...extra,
});

const page = (items: readonly unknown[], extra: Item = {}): Item => ({
  items,
  skip: 0,
  limit: 50,
  hasMore: false,
  archivedLeftOut: false,
  ...extra,
});

const ROWS = [
  summary(4, '/work/platform', { type: 'area', title: 'Platform' }),
  summary(12, '/work/platform/raphael', { title: 'Raphael', active: true }),
  note(305, '/work/platform/raphael/output-contract', {
    parentId: 12,
    title: 'Output contract  archived',
  }),
];

/** A stub answering each route from `answers`, keeping what was asked. */
const serving = (answers: Readonly<Record<string, unknown>>) => {
  const server = stubServer((request: StubRequest) => {
    const path = new URL(request.url).pathname;
    const body = answers[path];
    if (body === undefined) throw new Error(`No answer for ${path} in this case.`);
    return new Response(JSON.stringify(body), {
      status: path === NODE_ROUTES.create.path ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return server;
};

const ran = async (
  argv: readonly string[],
  answers: Readonly<Record<string, unknown>> = {},
  terminal: { readonly stdin?: boolean; readonly stdout?: boolean } = {},
): Promise<{ readonly ran: Ran; readonly requests: readonly StubRequest[] }> => {
  const server = serving(answers);
  const result = await runCli(argv, { connect: server.connect, terminal });
  return { ran: result, requests: server.requests };
};

/** Run a case, pin it, and check every request for an item asked for paths. */
const pinned = async (
  name: string,
  argv: readonly string[],
  answers: Readonly<Record<string, unknown>> = {},
  terminal: { readonly stdin?: boolean; readonly stdout?: boolean } = {},
): Promise<Ran> => {
  const { ran: result, requests } = await ran(argv, answers, terminal);
  output.expectRun(name, result);
  for (const request of requests) {
    if (new URL(request.url).pathname.endsWith('/verify')) continue;
    const body = request.body as Item;
    // The convenience read before a write only needs the revision; every answer printed has paths.
    if (new URL(request.url).pathname === NODE_ROUTES.get.path && argv[0] !== 'get') continue;
    assert.equal(body['includePaths'], true, `${name}: ${request.url}`);
  }
  return result;
};

const LIST = NODE_ROUTES.list.path;
const SEARCH = NODE_ROUTES.search.path;
const FAVORITES = NODE_ROUTES.listFavorites.path;

describe('page rows and notes', () => {
  it('prints id, type, state, path and title, with the title last', async () => {
    await pinned('list-rows', ['list', '/work', '-r'], { [LIST]: page(ROWS) });
  });

  it('prints a header only on a terminal', async () => {
    await pinned(
      'list-rows-terminal',
      ['list', '/work', '-r'],
      { [LIST]: page(ROWS) },
      { stdout: true },
    );
    await pinned('list-empty-terminal', ['list', '/work'], { [LIST]: page([]) }, { stdout: true });
  });

  it('gives the whole next command, keeping size, order and filter', async () => {
    await pinned(
      'list-more',
      [
        'list',
        '/',
        '-r',
        '--filter',
        '{"type":"resource"}',
        '--order-by',
        'updatedAt:desc',
        '--limit',
        '2',
        '--skip=2',
      ],
      { [LIST]: page(ROWS.slice(1), { skip: 2, limit: 2, hasMore: true }) },
    );
    await pinned('list-more-json', ['list', '/', '-r', '--limit', '2', '--json'], {
      [LIST]: page(ROWS.slice(1), { limit: 2, hasMore: true, archivedLeftOut: true }),
    });
  });

  it('describes the next command in words when it cannot be printed runnably', async () => {
    // A newline would print escaped, and the escaped text would run a different query.
    await pinned('search-more-unprintable', ['search', '/work', '-q', 'a\nb'], {
      [SEARCH]: page(
        ROWS.map((node) => ({ node })),
        { hasMore: true },
      ),
    });
    // zsh expands a bare `=word`, so it is quoted.
    await pinned('search-more-equals', ['search', '/work', '-q', '=x'], {
      [SEARCH]: page(
        ROWS.map((node) => ({ node })),
        { hasMore: true, archivedLeftOut: true },
      ),
    });
  });

  it('words each empty page for why it is empty', async () => {
    await pinned('list-empty', ['list', '/work'], { [LIST]: page([]) });
    await pinned('list-empty-places', ['list', '/work', '--id', '7'], { [LIST]: page([]) });
    await pinned('list-empty-filter', ['list', '/work', '--filter', '{"type":"project"}'], {
      [LIST]: page([]),
    });
    await pinned('list-past-end', ['list', '/work', '--skip', '100'], {
      [LIST]: page([], { skip: 100 }),
    });
    await pinned('list-archived-left-out', ['list', '/work'], {
      [LIST]: page([], { archivedLeftOut: true }),
    });
    await pinned('list-archived-left-out-rows', ['list', '/work', '-r'], {
      [LIST]: page(ROWS.slice(0, 1), { archivedLeftOut: true }),
    });
  });

  it('prints search hits as the same rows, and words an empty search', async () => {
    await pinned('search-rows', ['search', '/work', '-q', 'contract'], {
      [SEARCH]: page(ROWS.map((node) => ({ node }))),
    });
    await pinned('search-no-matches', ['search', '/work', '-q', 'zzzz'], { [SEARCH]: page([]) });
    await pinned('search-no-matches-direct', ['search', '/work', '--direct', '-q', 'zzzz'], {
      [SEARCH]: page([]),
    });
    await pinned(
      'search-archived-left-out',
      ['search', '/work', '-q', 'legacy word', '--filter', '{"type":"project"}'],
      { [SEARCH]: page([], { archivedLeftOut: true }) },
    );
  });

  it('prints favorites as the same rows, and says when archived ones were left out', async () => {
    await pinned('favorites-rows', ['favorites'], {
      [FAVORITES]: page(ROWS.slice(0, 2).map((item) => ({ ...item, isFavorite: true }))),
    });
    await pinned('favorites-empty', ['favorites'], { [FAVORITES]: page([]) });
    await pinned('favorites-empty-archived-left-out', ['favorites'], {
      [FAVORITES]: page([], { archivedLeftOut: true }),
    });
    await pinned('favorites-archived-left-out', ['favorites', '--limit', '1'], {
      [FAVORITES]: page([{ ...ROWS[0], isFavorite: true }], { limit: 1, archivedLeftOut: true }),
    });
    await pinned('favorites-include-archived', ['favorites', '--include-archived'], {
      [FAVORITES]: page([
        { ...ROWS[2], type: 'area', kind: null, archived: true, isFavorite: true },
      ]),
    });
  });
});

const created = entity(note(305, '/work/platform/raphael/output-contract', { revision: 1 }));
const CREATE = NODE_ROUTES.create.path;
const UPDATE = NODE_ROUTES.update.path;

describe('writes', () => {
  it('names the item, then its path and revision', async () => {
    await pinned(
      'create',
      [
        'create',
        'resource.note',
        '/work/platform/raphael/output-contract',
        '--body',
        '# Output contract',
      ],
      { [CREATE]: { entity: { ...created, title: 'Output contract' } } },
    );
    await pinned('update', ['update', '--id', '305', '--title', 'Renamed', '--revision', '1'], {
      [UPDATE]: { entity: { ...created, title: 'Renamed', revision: 2 }, changed: true },
    });
    await pinned(
      'update-unchanged',
      ['update', '--id', '305', '--title', 'Item 305', '--revision', '1'],
      { [UPDATE]: { entity: created, changed: false } },
    );
    await pinned(
      'update-unchanged-json',
      ['update', '--id', '305', '--title', 'Item 305', '--revision', '1', '--json'],
      { [UPDATE]: { entity: created, changed: false } },
    );
  });

  it('shows where a move came from, and says when it went nowhere', async () => {
    const moved = summary(12, '/engineering/raphael', { revision: 4 });
    await pinned('move', ['move', '/work/platform/raphael', '/engineering', '--revision', '3'], {
      [NODE_ROUTES.move.path]: {
        node: moved,
        changed: true,
        previousPath: '/work/platform/raphael',
      },
    });
    await pinned('move-unchanged', ['move', '--id', '12', '/engineering', '--revision', '4'], {
      [NODE_ROUTES.move.path]: {
        node: moved,
        changed: false,
        previousPath: '/engineering/raphael',
      },
    });
    await pinned('move-json', ['move', '--id', '12', '/engineering', '--revision', '3', '--json'], {
      [NODE_ROUTES.move.path]: {
        node: moved,
        changed: true,
        previousPath: '/work/platform/raphael',
      },
    });
  });

  it('archives and restores, naming the container a restore still waits on', async () => {
    const ARCHIVE = NODE_ROUTES.archive.path;
    const RESTORE = NODE_ROUTES.restore.path;
    const direct = {
      origin: { id: 12, type: 'project', title: 'Raphael' },
      owner: 'user',
      reason: 'direct',
    };
    const through = {
      origin: { id: 4, type: 'area', title: 'Platform' },
      owner: 'user',
      reason: 'direct',
    };
    const project = (extra: Item) =>
      summary(12, '/work/platform/raphael', { title: 'Raphael', ...extra });
    await pinned('archive', ['archive', '/work/platform/raphael', '--revision', '3'], {
      [ARCHIVE]: {
        node: project({ archived: true, revision: 4 }),
        archiveCauses: [direct],
        changed: true,
      },
    });
    await pinned('archive-unchanged', ['archive', '--id', '12', '--revision', '4'], {
      [ARCHIVE]: {
        node: project({ archived: true, revision: 4 }),
        archiveCauses: [direct],
        changed: false,
      },
    });
    await pinned('restore', ['restore', '--id', '12', '--revision', '4'], {
      [RESTORE]: { node: project({ revision: 5 }), archiveCauses: [], changed: true },
    });
    await pinned('restore-unchanged', ['restore', '--id', '12', '--revision', '5'], {
      [RESTORE]: { node: project({ revision: 5 }), archiveCauses: [], changed: false },
    });
    await pinned('restore-still-archived', ['restore', '--id', '12', '--revision', '4'], {
      [RESTORE]: {
        node: project({ archived: true, revision: 5 }),
        archiveCauses: [through],
        changed: true,
      },
    });
    await pinned('restore-still-archived-unchanged', ['restore', '--id', '12', '--revision', '5'], {
      [RESTORE]: {
        node: project({ archived: true, revision: 5 }),
        archiveCauses: [through],
        changed: false,
      },
    });
  });

  it('names what was marked, and says plainly when nothing was', async () => {
    const ADD = NODE_ROUTES.addFavorite.path;
    const REMOVE = NODE_ROUTES.removeFavorite.path;
    const area = (extra: Item) =>
      summary(4, '/work/platform', { type: 'area', title: 'Platform', ...extra });
    await pinned('favorite', ['favorite', '/work/platform'], {
      [ADD]: { nodeId: 4, isFavorite: true, changed: true, node: area({ isFavorite: true }) },
    });
    await pinned('favorite-unchanged', ['favorite', '--id', '4'], {
      [ADD]: { nodeId: 4, isFavorite: true, changed: false, node: area({ isFavorite: true }) },
    });
    await pinned('favorite-archived', ['favorite', '--id', '4'], {
      [ADD]: {
        nodeId: 4,
        isFavorite: true,
        changed: true,
        node: area({ isFavorite: true, archived: true }),
      },
    });
    await pinned('unfavorite', ['unfavorite', '--id', '4'], {
      [REMOVE]: { nodeId: 4, isFavorite: false, changed: true, node: area({}) },
    });
    await pinned('unfavorite-unchanged', ['unfavorite', '--id', '4'], {
      [REMOVE]: { nodeId: 4, isFavorite: false, changed: false, node: area({}) },
    });
    await pinned('unfavorite-unknown-id', ['unfavorite', '--id', '999'], {
      [REMOVE]: { nodeId: 999, isFavorite: false, changed: false, node: null },
    });
    await pinned('unfavorite-unknown-id-json', ['unfavorite', '--id', '999', '--json'], {
      [REMOVE]: { nodeId: 999, isFavorite: false, changed: false, node: null },
    });
  });
});

describe('get', () => {
  const GET = NODE_ROUTES.get.path;
  it('prints every field, the update time as sent, then the body', async () => {
    await pinned('get', ['get', '/work/platform/raphael'], {
      [GET]: {
        entity: entity(summary(12, '/work/platform/raphael', { title: 'Raphael', active: true }), {
          description: 'The second brain',
          tags: ['a, b', 'c', ' padded'],
          metadata: { owner: 'noor' },
        }),
      },
    });
  });

  it('prints no trailing blank lines for an empty body', async () => {
    await pinned('get-empty-body', ['get', '--id', '4'], {
      [GET]: {
        entity: entity(summary(4, '/work/platform', { type: 'area', title: 'Platform' }), {
          body: { format: 'markdown', value: '' },
        }),
      },
    });
  });

  it('puts archive causes under archived', async () => {
    await pinned('get-archived', ['get', '--id', '305'], {
      [GET]: {
        entity: entity(
          note(305, '/work/platform/raphael/output-contract', { archived: true, parentId: 12 }),
          {
            archiveCauses: [
              {
                origin: { id: 4, type: 'area', title: 'Platform' },
                owner: 'user',
                reason: 'direct',
              },
            ],
          },
        ),
      },
    });
  });
});

describe('the body', () => {
  it('warns when Markdown is stored with constructs kept only as text', async () => {
    await pinned(
      'create-degraded',
      [
        'create',
        'resource.note',
        '/work/table',
        '--title',
        'Table',
        '--body',
        '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] todo\n\n![chart](https://example.com/c.png) <b>bold</b>',
      ],
      { [CREATE]: { entity: { ...created, title: 'Table', path: '/work/table' } } },
    );
    await pinned(
      'create-degraded-json',
      [
        'create',
        'resource.note',
        '/work/table',
        '--title',
        'Table',
        '--body',
        '#### Deep',
        '--json',
      ],
      { [CREATE]: { entity: { ...created, title: 'Table', path: '/work/table' } } },
    );
    await pinned(
      'update-degraded',
      ['update', '--id', '305', '--body', 'See [notes](./notes.md).', '--revision', '1'],
      { [UPDATE]: { entity: { ...created, revision: 2 }, changed: true } },
    );
    // Nothing was stored, so nothing was stored with changes.
    await pinned(
      'update-degraded-unchanged',
      ['update', '--id', '305', '--body', 'See [notes](./notes.md).', '--revision', '1'],
      { [UPDATE]: { entity: created, changed: false } },
    );
    // Rewrites that keep the meaning are not reported.
    await pinned(
      'create-normalized',
      [
        'create',
        'resource.note',
        '/work/plain',
        '--body',
        '# Plain\n\n$5 * 3 and a < b > c\nnext line',
      ],
      { [CREATE]: { entity: { ...created, title: 'Plain', path: '/work/plain' } } },
    );
  });

  it('refuses instead with --strict, before anything is sent', async () => {
    const strict = await pinned('create-strict', [
      'create',
      'resource.note',
      '/work/table',
      '--title',
      'Table',
      '--body',
      '| a |\n|---|\n| 1 |\n\n![x](y.png)',
      '--strict',
    ]);
    assert.equal(strict.code, 2);
    await pinned('create-strict-json', [
      'create',
      'resource.note',
      '/work/table',
      '--title',
      'Table',
      '--body',
      '| a |\n|---|\n| 1 |',
      '--strict',
      '--json',
    ]);
    await pinned(
      'create-strict-clean',
      ['create', 'resource.note', '/work/plain', '--body', '# Plain', '--strict'],
      { [CREATE]: { entity: { ...created, title: 'Plain', path: '/work/plain' } } },
    );
    // Destinations the parser refuses on its own, by an encoded scheme or on an image, are caught too.
    await pinned('create-strict-encoded-scheme', [
      'create',
      'resource.note',
      '/work/link',
      '--title',
      'Link',
      '--body',
      '[x](java&#x73;cript:alert(1))',
      '--strict',
      '--json',
    ]);
    await pinned('create-strict-refused-image', [
      'create',
      'resource.note',
      '/work/image',
      '--title',
      'Image',
      '--body',
      '![x](data:text/html,hello)',
      '--strict',
      '--json',
    ]);
    // A refused link with no label, and HTML whose attribute holds an entity, are caught too.
    await pinned('create-strict-empty-label-link', [
      'create',
      'resource.note',
      '/work/link',
      '--title',
      'Link',
      '--body',
      '[](javascript:alert(1))',
      '--strict',
      '--json',
    ]);
    await pinned('create-strict-encoded-html', [
      'create',
      'resource.note',
      '/work/html',
      '--title',
      'Html',
      '--body',
      '<img src="a&amp;b">',
      '--strict',
      '--json',
    ]);
    // Entities that decode to quotes or `<` do not hide the HTML that was written.
    await pinned('create-strict-entity-quote', [
      'create',
      'resource.note',
      '/work/html',
      '--title',
      'Html',
      '--body',
      '<input value="&quot;">',
      '--strict',
      '--json',
    ]);
    await pinned('create-strict-entity-quoted-alt', [
      'create',
      'resource.note',
      '/work/html',
      '--title',
      'Html',
      '--body',
      '<img alt="&quot;x&quot;">',
      '--strict',
      '--json',
    ]);
    await pinned('create-strict-entity-angle', [
      'create',
      'resource.note',
      '/work/html',
      '--title',
      'Html',
      '--body',
      '<input value=&#60;x>',
      '--strict',
      '--json',
    ]);
    await pinned('update-strict-without-body', ['update', '--id', '4', '--title', 'X', '--strict']);
    await pinned('create-strict-tiptap', [
      'create',
      'resource.note',
      '/work/doc',
      '--body',
      '{"type":"doc","content":[]}',
      '--body-format',
      'tiptap',
      '--strict',
    ]);
  });

  it('refuses a TipTap document sent as Markdown, from any source', async () => {
    await pinned('create-tiptap-as-markdown', [
      'create',
      'resource.note',
      '/work/doc',
      '--title',
      'Doc',
      '--body',
      ' {"type":"doc","content":[{"type":"paragraph"}]}\n',
    ]);
    await pinned('update-tiptap-as-markdown-literal', [
      'update',
      '--id',
      '305',
      '--body-literal',
      '{"type":"doc"}',
      '--revision',
      '1',
    ]);
    // JSON that is not a document is ordinary text.
    await pinned(
      'create-json-text',
      ['create', 'resource.note', '/work/json', '--title', 'Json', '--body', '{"type":"other"}'],
      { [CREATE]: { entity: { ...created, title: 'Json', path: '/work/json' } } },
    );
  });

  it('tells a missing body from an unreadable one when a title must come from it', async () => {
    await pinned('create-no-title-no-body', ['create', 'resource.note', '/work/nameless']);
    await pinned(
      'create-no-title-no-body-terminal',
      ['create', 'resource.note', '/work/nameless'],
      {},
      { stdin: true },
    );
    await pinned('create-no-title-empty-body', [
      'create',
      'resource.note',
      '/work/nameless',
      '--body',
      '```\n\n```',
    ]);
    await pinned('create-no-title-unconvertible-body', [
      'create',
      'resource.note',
      '/work/nameless',
      '--body',
      '{"type":"doc","content":[{"type":"bogus"}]}',
      '--body-format',
      'tiptap',
    ]);
  });

  it('says how to send a body when an update has no change', async () => {
    await pinned('update-no-change', ['update', '--id', '4']);
    await pinned('update-no-change-terminal', ['update', '--id', '4'], {}, { stdin: true });
  });
});
