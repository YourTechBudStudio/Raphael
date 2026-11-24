import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ApiCredential, serve, silentLogger } from '@raphael/backend';
import { createTransport, type FetchLike, type Transport } from '@raphael/client';
import {
  DESCRIPTION_MAX_CODE_POINTS,
  NODE_ROUTES,
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_QUERY_MAX_TERMS,
  SLUG_MAX_CODE_POINTS,
  TAGS_MAX_COUNT,
  TAG_MAX_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
  asSentence,
  decodeListResponse,
  describeDescriptionRejection,
  describeFilterRejection,
  describePathRejection,
  describeQueryRejection,
  describeSlugRejection,
  describeTagsRejection,
  describeTitleRejection,
  inspectMetadataInput,
} from '@raphael/contracts/nodes';
import { Effect, Exit, Scope } from 'effect';

import { version } from '../src/distribution.ts';
import { neverConnect, runCli } from './support/cli.ts';
import { goldenSurface } from './support/golden.ts';

/**
 * One rule, two places that refuse it: this CLI before sending, and the server when a request
 * arrives without the CLI's checks (from another client, or an older one). Both must say the same
 * thing, in the contract's words, with the same limit from the same constant, so a copy change on
 * one side cannot leave the other behind.
 *
 * Each row runs the CLI, which refuses locally and never connects, and sends the equivalent request
 * straight to a real server, past the client's own request decoder, and holds both against the one
 * sentence the contract's describer produces. The two answers are also kept side by side in a golden
 * file, so any change to either reads as one diff.
 */

const KEY = 'test-key-0123456789abcdef0123456789';
const copy = goldenSurface('rule-copy');

let scope: Scope.CloseableScope;
let transport: Transport;
let data = '';

before(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-rule-copy-')));
  scope = Effect.runSync(Scope.make());
  const running = await Effect.runPromise(
    Scope.extend(
      serve({
        options: {
          server: { host: '127.0.0.1', port: 0 },
          database: { databasePath: join(data, 'raphael.sqlite') },
        },
        credential: ApiCredential.fromKey(KEY),
        release: version(),
        logger: silentLogger,
      }),
      scope,
    ),
  );
  transport = createTransport({
    endpoint: `http://127.0.0.1:${running.port}`,
    apiKey: KEY,
    fetch: fetch as unknown as FetchLike,
  }) as Transport;
});

after(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(data, { recursive: true, force: true });
  assert.deepEqual(copy.strays(), []);
});

/** The server's message for a request sent as it is, with no client checks in front of it. */
const serverSays = async (
  route: (typeof NODE_ROUTES)[keyof typeof NODE_ROUTES],
  body: unknown,
): Promise<string> => {
  const result = await transport.invoke({
    route,
    effect: route === NODE_ROUTES.create ? 'write' : 'read',
    body,
    decode: decodeListResponse,
    successStatus: route === NODE_ROUTES.create ? 201 : 200,
  });
  assert.equal(result.ok, false, 'the server refuses it');
  if (result.ok) return '';
  assert.equal(result.failure.kind, 'http');
  assert.equal(result.failure.status, 400);
  return result.failure.message;
};

interface Row {
  /** The rule, in the contract's words: what both sides must say. */
  readonly rule: string;
  /** The limit the rule states, from its constant, when it has one. */
  readonly limit?: number;
  /** How the CLI names what was typed, before the rule. */
  readonly flag: string;
  readonly cli: readonly string[];
  readonly route: (typeof NODE_ROUTES)[keyof typeof NODE_ROUTES];
  readonly request: unknown;
}

const root = { path: '/' };
const long = (length: number): string => 'a'.repeat(length);
const manyTags = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t${index}`);
const terms = (count: number): string =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

const ROWS: Readonly<Record<string, Row>> = {
  'title-required': {
    rule: describeTitleRejection({ reason: 'title_required' }),
    flag: '--title',
    cli: ['create', 'area', '/work'],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: 'work' },
  },
  'title-too-long': {
    rule: describeTitleRejection({ reason: 'title_too_long', limit: TITLE_MAX_CODE_POINTS }),
    limit: TITLE_MAX_CODE_POINTS,
    flag: '--title',
    cli: ['create', 'area', '/work', '--title', long(TITLE_MAX_CODE_POINTS + 1)],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: 'work', title: long(TITLE_MAX_CODE_POINTS + 1) },
  },
  'slug-grammar': {
    rule: describeSlugRejection({ reason: 'not_slug' }),
    flag: '--slug',
    cli: ['create', 'area', '--parent-id', '1', '--slug', 'Not_a_slug', '--title', 'Work'],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: 'Not_a_slug', title: 'Work' },
  },
  'slug-too-long': {
    rule: describeSlugRejection({ reason: 'slug_too_long', limit: SLUG_MAX_CODE_POINTS }),
    limit: SLUG_MAX_CODE_POINTS,
    flag: '--slug',
    cli: [
      'create',
      'area',
      '--parent-id',
      '1',
      '--slug',
      long(SLUG_MAX_CODE_POINTS + 1),
      '--title',
      'Work',
    ],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: long(SLUG_MAX_CODE_POINTS + 1), title: 'Work' },
  },
  'query-malformed': {
    rule: describeQueryRejection({ reason: 'dangling_operator' }),
    flag: '-q',
    cli: ['search', '/', '-q', 'auth AND'],
    route: NODE_ROUTES.search,
    request: { scopes: [root], queries: ['auth AND'] },
  },
  'query-too-long': {
    rule: describeQueryRejection({ reason: 'too_long', limit: SEARCH_QUERY_MAX_CODE_POINTS }),
    limit: SEARCH_QUERY_MAX_CODE_POINTS,
    flag: '-q',
    cli: ['search', '/', '-q', long(SEARCH_QUERY_MAX_CODE_POINTS + 1)],
    route: NODE_ROUTES.search,
    request: { scopes: [root], queries: [long(SEARCH_QUERY_MAX_CODE_POINTS + 1)] },
  },
  'query-too-many-terms': {
    rule: describeQueryRejection({ reason: 'too_many_terms', limit: SEARCH_QUERY_MAX_TERMS }),
    limit: SEARCH_QUERY_MAX_TERMS,
    flag: '-q',
    cli: ['search', '/', '-q', terms(SEARCH_QUERY_MAX_TERMS + 1)],
    route: NODE_ROUTES.search,
    request: { scopes: [root], queries: [terms(SEARCH_QUERY_MAX_TERMS + 1)] },
  },
  'filter-key': {
    rule: describeFilterRejection({ reason: 'unsupported_key' }),
    flag: '--filter',
    cli: ['list', '/', '--filter', '{"title":"x"}'],
    route: NODE_ROUTES.list,
    request: { scopes: [root], filter: { title: 'x' } },
  },
  'filter-value': {
    rule: describeFilterRejection({ reason: 'invalid_value', key: 'type' }),
    flag: '--filter',
    cli: ['list', '/', '--filter', '{"type":"folder"}'],
    route: NODE_ROUTES.list,
    request: { scopes: [root], filter: { type: 'folder' } },
  },
  'tags-empty': {
    rule: describeTagsRejection({ reason: 'tag_empty' }),
    flag: '--tag',
    cli: ['create', 'area', '/work', '--title', 'Work', '--tag', ' '],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: 'work', title: 'Work', tags: [' '] },
  },
  'tags-too-long': {
    rule: describeTagsRejection({ reason: 'tag_too_long', limit: TAG_MAX_CODE_POINTS }),
    limit: TAG_MAX_CODE_POINTS,
    flag: '--tag',
    cli: ['create', 'area', '/work', '--title', 'Work', '--tag', long(TAG_MAX_CODE_POINTS + 1)],
    route: NODE_ROUTES.create,
    request: {
      type: 'area',
      parent: root,
      slug: 'work',
      title: 'Work',
      tags: [long(TAG_MAX_CODE_POINTS + 1)],
    },
  },
  'tags-repeat': {
    rule: describeTagsRejection({ reason: 'tags_repeat' }),
    flag: '--tag',
    cli: ['create', 'area', '/work', '--title', 'Work', '--tag', 'x', '--tag', 'x'],
    route: NODE_ROUTES.create,
    request: { type: 'area', parent: root, slug: 'work', title: 'Work', tags: ['x', 'x'] },
  },
  'tags-too-many': {
    rule: describeTagsRejection({ reason: 'tags_too_many', limit: TAGS_MAX_COUNT }),
    limit: TAGS_MAX_COUNT,
    flag: '--tag',
    cli: [
      'create',
      'area',
      '/work',
      '--title',
      'Work',
      ...manyTags(TAGS_MAX_COUNT + 1).flatMap((tag) => ['--tag', tag]),
    ],
    route: NODE_ROUTES.create,
    request: {
      type: 'area',
      parent: root,
      slug: 'work',
      title: 'Work',
      tags: manyTags(TAGS_MAX_COUNT + 1),
    },
  },
  'description-too-long': {
    rule: describeDescriptionRejection({
      reason: 'description_too_long',
      limit: DESCRIPTION_MAX_CODE_POINTS,
    }),
    limit: DESCRIPTION_MAX_CODE_POINTS,
    flag: '--description',
    cli: [
      'create',
      'area',
      '/work',
      '--title',
      'Work',
      '--description',
      long(DESCRIPTION_MAX_CODE_POINTS + 1),
    ],
    route: NODE_ROUTES.create,
    request: {
      type: 'area',
      parent: root,
      slug: 'work',
      title: 'Work',
      description: long(DESCRIPTION_MAX_CODE_POINTS + 1),
    },
  },
  'metadata-not-object': {
    rule: inspectMetadataInput([1, 2])?.detail ?? '',
    flag: '--metadata',
    cli: ['create', 'resource.note', '/work/n', '--title', 'N', '--metadata', '[1,2]'],
    route: NODE_ROUTES.create,
    request: {
      type: 'resource',
      kind: 'note',
      parent: root,
      slug: 'n',
      title: 'N',
      metadata: [1, 2],
    },
  },
  'path-not-absolute': {
    rule: describePathRejection({ reason: 'not_absolute', segment: undefined }),
    flag: 'path',
    cli: ['list', 'work'],
    route: NODE_ROUTES.list,
    request: { scopes: [{ path: 'work' }] },
  },
  'path-segment': {
    rule: describePathRejection({ reason: 'noncanonical_segment', segment: 0 }),
    flag: 'path',
    cli: ['list', '/Work'],
    route: NODE_ROUTES.list,
    request: { scopes: [{ path: '/Work' }] },
  },
};

describe('one rule reads the same from this CLI and from the server', () => {
  for (const [name, row] of Object.entries(ROWS)) {
    it(name, async () => {
      const sentence = asSentence(row.rule);
      if (row.limit !== undefined) assert.ok(sentence.includes(String(row.limit)), sentence);

      const client = await runCli(row.cli, { connect: neverConnect });
      assert.equal(client.code, 2, client.stderr);
      const [line = ''] = client.stderr.split('\n');
      assert.equal(line, `${row.flag}: ${sentence}`, 'the CLI words it from the contract');

      const server = await serverSays(row.route, row.request);
      assert.equal(server, sentence, 'the server words it from the contract');

      copy.expectText(name, `cli:    ${line}\nserver: ${server}`);
    });
  }
});
