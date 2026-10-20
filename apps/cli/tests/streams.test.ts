import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NODE_ROUTES } from '@raphael/contracts/nodes';

import { REMOTE_COMMAND_NAMES } from '../src/main.ts';
import { errorResponse, runCli, stubServer, type Ran, type StubRequest } from './support/cli.ts';
import { assertErrorDocument } from './support/golden.ts';

/**
 * stdout holds results and nothing else: rows, or exactly one JSON document.
 *
 * Every remote command is run against a stub server that answers each operation with a valid result,
 * as text and with `--json`, and then against one that refuses everything. A success with `--json`
 * prints one document on one line and nothing on stderr; a page printed for a person has only rows on
 * stdout, with its note on stderr; and a failure prints nothing on stdout at all.
 */

const summary = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'project',
  kind: null,
  parentId: 2,
  slug: `item-${id}`,
  revision: 3,
  title: `Item ${id}`,
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  ...extra,
});

const entity = {
  ...summary(7),
  body: { format: 'markdown', value: '# Body\n' },
  metadata: {},
  archiveCauses: [],
};

const page = (items: unknown[]) => ({ items, skip: 0, limit: 50, hasMore: false });

/** A valid answer for each route, as the contract defines it. */
const ANSWERS: Readonly<Record<string, unknown>> = {
  [NODE_ROUTES.create.path]: { entity },
  [NODE_ROUTES.get.path]: { entity },
  [NODE_ROUTES.update.path]: { entity },
  [NODE_ROUTES.move.path]: { node: summary(7) },
  [NODE_ROUTES.archive.path]: { node: summary(7), archiveCauses: [] },
  [NODE_ROUTES.restore.path]: { node: summary(7), archiveCauses: [] },
  [NODE_ROUTES.addFavorite.path]: { nodeId: 7, isFavorite: true },
  [NODE_ROUTES.removeFavorite.path]: { nodeId: 7, isFavorite: false },
  [NODE_ROUTES.listFavorites.path]: page([summary(7), summary(8, { active: true })]),
  [NODE_ROUTES.getPath.path]: { id: 7, path: '/work/item-7' },
  [NODE_ROUTES.list.path]: page([summary(7), summary(8, { archived: true })]),
  [NODE_ROUTES.search.path]: {
    ...page([{ node: summary(7) }, { node: summary(8, { title: 'Spoof  archived' }) }]),
    archivedLeftOut: false,
  },
};

const answer = (request: StubRequest): Response => {
  const path = new URL(request.url).pathname;
  const body = ANSWERS[path];
  if (body === undefined) throw new Error(`No canned answer for ${path}`);
  return new Response(JSON.stringify(body), {
    status: path === NODE_ROUTES.create.path ? 201 : 200,
    headers: { 'content-type': 'application/json' },
  });
};

/** One realistic invocation per remote command. */
const INVOCATIONS: Readonly<Record<(typeof REMOTE_COMMAND_NAMES)[number], readonly string[]>> = {
  create: ['create', 'project', '/work/item-7', '--title', 'Item 7'],
  update: ['update', '/work/item-7', '--title', 'Item 7'],
  move: ['move', '/work/item-7', '/personal'],
  archive: ['archive', '/work/item-7'],
  restore: ['restore', '/work/item-7'],
  favorite: ['favorite', '/work/item-7'],
  unfavorite: ['unfavorite', '/work/item-7'],
  favorites: ['favorites'],
  get: ['get', '/work/item-7'],
  path: ['path', '--id', '7'],
  list: ['list', '/work'],
  search: ['search', '/work', '-q', 'item'],
};

/** Commands whose human output is a page of rows. */
const PAGES = new Set(['list', 'search', 'favorites']);

/** A row: an id, a type, a state word, then free text. */
const ROW = /^\d+ +(?:area|project|resource\.\w+) +(?:-|active|archived|active,archived) {2,}\S/u;

const succeed = (argv: readonly string[]): Promise<Ran> =>
  runCli(argv, { connect: stubServer(answer).connect });

describe('stdout on success', () => {
  for (const command of REMOTE_COMMAND_NAMES) {
    const argv = INVOCATIONS[command];

    it(`${command} --json prints exactly one JSON document, and nothing else`, async () => {
      const ran = await succeed([...argv, '--json']);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(ran.stderr, '', 'nothing besides the result');
      assert.ok(ran.stdout.endsWith('\n'));
      assert.equal(ran.stdout.trimEnd().includes('\n'), false, 'one document, on one line');
      const document = JSON.parse(ran.stdout) as Record<string, unknown>;
      assert.equal(document.ok, true);
      assert.equal(document.command, command);
    });

    it(`${command} prints ${PAGES.has(command) ? 'only rows' : 'its result'} on stdout`, async () => {
      const ran = await succeed(argv);
      assert.equal(ran.code, 0, ran.stderr);
      assert.notEqual(ran.stdout, '');
      if (PAGES.has(command)) {
        for (const line of ran.stdout.trimEnd().split('\n')) assert.match(line, ROW);
        assert.match(ran.stderr, /shown, skip 0, limit 50/, 'the page note is on stderr');
      } else {
        assert.equal(ran.stderr, '');
      }
    });
  }

  it('prints an empty page as nothing on stdout', async () => {
    const empty = stubServer(
      () =>
        new Response(JSON.stringify(page([])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const ran = await runCli(['list', '/work'], { connect: empty.connect });
    assert.equal(ran.code, 0);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /^Nothing here/);
  });

  it('keeps a state word out of the free text, so a title cannot imitate one', async () => {
    const ran = await succeed(INVOCATIONS.search);
    const spoof = ran.stdout.split('\n').find((line) => line.includes('Spoof'));
    // The real state column says "-"; "archived" only appears inside the title, after it.
    assert.match(spoof ?? '', /^8 +project +- {2}item-8 {2}Spoof {2}archived$/);
  });
});

describe('stdout on failure', () => {
  const refusing = () => stubServer(() => errorResponse(404, 'node_not_found', 'Not there.'));

  for (const command of REMOTE_COMMAND_NAMES) {
    const argv = INVOCATIONS[command];

    it(`${command} prints nothing on stdout when it fails`, async () => {
      const ran = await runCli(argv, { connect: refusing().connect });
      assert.equal(ran.code, 3);
      assert.equal(ran.stdout, '');
    });

    it(`${command} --json prints one error document on stderr when it fails`, async () => {
      const ran = await runCli([...argv, '--json'], { connect: refusing().connect });
      assertErrorDocument(ran, { exit: 3, code: 'node_not_found', command });
    });
  }

  it('reports a usage error as a JSON document when --json was given, even before parsing', async () => {
    for (const argv of [
      ['get', '/work', '--nonsense', '--json'],
      ['lst', '/work', '--json'],
      ['create', '--json'],
      // Entry points outside the remote table, which take no --json of their own yet.
      ['version', '--json'],
      ['server', 'nope', '--json'],
      ['server', 'serve', '--port', '1', '--json'],
      // A flag missing its value: the lenient parser takes --json as that value, strict parsing fails.
      ['get', '--id', '--json'],
      ['create', 'project', '/work/x', '--title', '--json'],
      ['get', '/work', '--return-format', '--json'],
    ]) {
      const ran = await runCli(argv);
      assertErrorDocument(ran, { exit: 2, code: 'usage' });
    }
  });

  it('does not mistake a value spelled --json for the flag', async () => {
    const ran = await runCli(['search', '/work', '--query=--json'], {
      connect: stubServer(() => errorResponse(404, 'node_not_found', 'x')).connect,
    });
    assert.equal(ran.code, 3);
    assert.equal(ran.stderr.startsWith('{'), false, 'text, not a JSON document');
    assert.match(ran.stderr, /^Nothing exists at \/work\.$/m);
  });
});
