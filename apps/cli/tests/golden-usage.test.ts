import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import {
  DESCRIPTION_MAX_CODE_POINTS,
  NODE_ORDER_FIELDS,
  SCOPES_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
} from '@raphael/contracts/nodes';

import { errorResponse, runCli, stubServer, type Ran } from './support/cli.ts';
import {
  assertErrorDocument,
  assertJsonMirrorsText,
  caseName,
  goldenSurface,
} from './support/golden.ts';

/**
 * How every local usage refusal reads: one case per sentence the CLI writes itself, from the
 * `UsageError` sites in `src` and the parser's own diagnostics.
 *
 * Each runs the real entry point against a stub server that must not be contacted, as text and,
 * unless `--json` would change what is refused, again with `--json`. The text is pinned; the JSON is
 * checked against the text, and pinned only where marked `json: 'pin'`. Refusals pinned
 * by another surface (contract rules in `rules`, input sources in `refusals`, login in `login`) are
 * not repeated here. A sentence no input can reach is recorded as unreachable, with the reason.
 */

const usage = goldenSurface('usage');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-usage-')));
const notUtf8 = join(directory, 'latin1.md');
writeFileSync(notUtf8, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

after(() => {
  rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(usage.strays(), []);
});

type Case =
  | { readonly argv: readonly string[]; readonly text?: true; readonly json?: 'pin' }
  | { readonly unreachable: string };

const NOTE = ['create', 'resource.note', '/work/n', '--title', 'N'];

const CASES: Readonly<Record<string, Case>> = {
  // Arguments a command does not take.
  'root-help-arguments': { argv: ['--help', 'extra'] },
  'root-help-command': { argv: ['-h', 'list'] },
  'root-help-topic': { argv: ['--help', 'content'] },
  'version-arguments': { argv: ['version', 'extra'] },
  'status-arguments': { argv: ['status', 'extra'] },
  'logout-arguments': { argv: ['logout', 'extra'] },
  // Pinned as JSON too: `--json` is itself refused here, so the JSON is a different refusal.
  'serve-arguments': { argv: ['server', 'serve', 'extra'], json: 'pin' },
  'create-extra': { argv: ['create', 'area', '/work/a', '/work/b', '--title', 'A'] },
  'update-extra': { argv: ['update', '/work/a', '/work/b', '--title', 'A'] },
  'move-extra': { argv: ['move', '/work/a', '/work/b', '/work/c'] },
  'path-extra': { argv: ['path', '/work/a', '/work/b'] },
  // What a command needs and was not given.
  'create-no-type': { argv: ['create'] },
  'create-incomplete': { argv: ['create', 'area', '--parent-id', '1', '--title', 'A'] },
  'create-path-and-parent': {
    argv: ['create', 'area', '/work/a', '--parent-id', '1', '--slug', 'a', '--title', 'A'],
  },
  'create-root': { argv: ['create', 'area', '/', '--title', 'Root'] },
  'get-no-target': { argv: ['get'] },
  'get-path-and-id': { argv: ['get', '/work', '--id', '2'] },
  'move-no-destination': { argv: ['move', '/work/a'] },
  'list-no-target': { argv: ['list'] },
  'search-no-query': { argv: ['search', '/work'] },
  // Pinned as JSON too: the usage error document's shape.
  'needs-value': { argv: ['get', '--id'], json: 'pin' },
  // Options that cannot go together, or need another.
  'update-active-and-inactive': { argv: ['update', '/work/raphael', '--active', '--inactive'] },
  'update-tag-and-no-tags': { argv: ['update', '/work', '--tag', 'a', '--no-tags'] },
  'update-body-without-revision': { argv: ['update', '/work/n', '--body', 'x'] },
  'body-and-literal': { argv: [...NOTE, '--body', 'a', '--body-literal', 'b'] },
  // `--json` would make this one succeed, so it is pinned as text only.
  'return-format-without-json': { argv: ['get', '/work', '--return-format', 'tiptap'], text: true },
  // Counts and repeats.
  'too-many-targets': {
    argv: ['list', ...Array.from({ length: SCOPES_MAX_COUNT + 1 }, (_, index) => `/a${index}`)],
  },
  'repeated-target': { argv: ['list', '/work', '/work'] },
  'too-many-queries': {
    argv: [
      'search',
      '/work',
      ...Array.from({ length: SEARCH_QUERIES_MAX_COUNT + 1 }, (_, index) => [
        '-q',
        `q${index}`,
      ]).flat(),
    ],
  },
  'order-by-shape': { argv: ['list', '/work', '--order-by', 'title'] },
  'order-by-field': { argv: ['list', '/work', '--order-by', 'colour:asc'] },
  'order-by-direction': { argv: ['list', '/work', '--order-by', `${NODE_ORDER_FIELDS[0]}:up`] },
  'order-by-too-many': {
    argv: [
      'list',
      '/work',
      ...[...NODE_ORDER_FIELDS, NODE_ORDER_FIELDS[0]].flatMap((field) => [
        '--order-by',
        `${field}:asc`,
      ]),
    ],
  },
  // Values the CLI refuses in its own words.
  'id-too-large': { argv: ['get', '--id', '99999999999999999999'] },
  'tag-with-comma': { argv: [...NOTE, '--tag', 'a,b'] },
  'description-too-long': {
    argv: ['update', '/work', '--description', 'd'.repeat(DESCRIPTION_MAX_CODE_POINTS + 1)],
  },
  'metadata-not-json': { argv: [...NOTE, '--metadata', '{"a":'] },
  'metadata-stdin': { argv: [...NOTE, '--metadata', '@-'] },
  'filter-stdin': { argv: ['list', '/work', '--filter', '@-'] },
  'body-file-not-utf8': { argv: [...NOTE, '--body', `@${notUtf8}`] },
  'body-tiptap-not-json': {
    argv: ['create', 'resource.note', '/work/n', '--body-format', 'tiptap', '--body', '{"type":'],
  },
  'request-too-large': { argv: [...NOTE, '--body-literal', 'x'.repeat(REQUEST_MAX_BYTES)] },
  // A help name that is neither a command nor a topic: the closest command or topic, or the list.
  'help-unknown-command': { argv: ['help', 'lst'] },
  'help-unknown-topic': { argv: ['help', 'adressing'] },
  'help-unknown-topic-prefix': { argv: ['help', 'exit'] },
  'help-unknown': { argv: ['help', 'xyzzy'] },
  // A correction the CLI knows is given as the whole command to run.
  'create-kind-as-type': { argv: ['create', 'note', '/work/x', '--body', 'hi'] },
  'unknown-option': { argv: ['create', 'area', '/work/x', '--titel', 'X'] },
  'unknown-option-joined': { argv: ['create', 'area', '/work/x', '--titel=X'] },
  'path-not-canonical': { argv: ['get', '/Work'] },
  // An id typed where a path goes is offered as --id, and an empty path is never taken for the root.
  'id-as-path': { argv: ['get', '9'] },
  'id-as-path-list': { argv: ['list', '/work', '9'] },
  'empty-path': { argv: ['get', ''] },
  'empty-path-list': { argv: ['list', ''] },
  // A misspelled option: one it begins wins, a tie or an option already given suggests nothing, and a
  // suggestion is made only when the command it makes parses.
  // Pinned as JSON too: a suggested command keeps --json.
  'option-prefix-value': { argv: ['list', '/work', '--lim', '5'], json: 'pin' },
  'option-prefix-flag': { argv: ['search', '/work', '-q', 'x', '--dir'] },
  'option-tie': { argv: ['update', '/work', '--nactive'] },
  'option-already-given': { argv: ['list', '/work', '--json', '--jsn'], text: true },
  'option-already-given-joined': { argv: ['server', 'serve', '--port', '3100', '--prot=3101'] },
  'option-needs-value-at-end': { argv: ['server', 'serve', '--prt'] },
  // "Needs a value" gives an example from the option's definition, and the = form only where a value
  // may start with a dash.
  'needs-value-number': { argv: ['server', 'serve', '--port'] },
  'needs-value-text': { argv: [...NOTE, '--tag'] },
  'needs-value-slug': {
    argv: ['create', 'area', '--parent-id', '1', '--slug', '-a', '--title', 'A'],
  },
  'needs-value-choice': { argv: [...NOTE, '--body-format'] },
  // The parser's own diagnostics.
  'search-recursive': { argv: ['search', '/work', '-q', 'a', '-r'] },
  'update-metadata': { argv: ['update', '/work', '--metadata', '{}'] },
  'renamed-flag': { argv: ['get', '/work', '--format', 'tiptap'] },
  // A value given to --json still asks for JSON, so this one run is the JSON form.
  'flag-takes-no-value': { argv: ['list', '/work', '--json=yes'], text: true },
  'short-flag-takes-no-value': { argv: ['list', '/work', '-r=true'] },
  'repeated-flag': {
    argv: ['get', '/work', '--return-format', 'markdown', '--return-format', 'tiptap'],
  },
  // Unreachable sentences.
  'path-not-absolute-on-create': {
    unreachable:
      "splitCreatePath runs the contract's path check first, which refuses a relative path in its own words",
  },
  'title-from-unreadable-body': {
    unreachable:
      "every body is checked with the content package's inspectors before a title is derived from it, so one that cannot be converted is refused first, in the words pinned in failures",
  },
  'metadata-not-object': {
    unreachable:
      'inspectMetadataInput refuses a value that is not an object first, in the contract words pinned in rules',
  },
};

/** The words of a command as `shellArg` quotes them: spaces between, '...' around, '\\'' inside. */
const shellWords = (command: string): string[] => {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quoted) {
      if (character === "'") quoted = false;
      else word += character;
    } else if (character === "'") {
      quoted = true;
      started = true;
    } else if (character === '\\') {
      word += command[(index += 1)] ?? '';
      started = true;
    } else if (character === ' ') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
};

/**
 * A refusal that gives the whole command to run gives one that parses: followed against a server
 * that finds nothing, it is answered by the server or by help, never refused as typed.
 */
const assertSuggestionParses = async (stderr: string): Promise<void> => {
  const suggested = /^hint: Did you mean "raphael (.*)"\?$/mu.exec(stderr)?.[1];
  if (suggested === undefined) return;
  const server = stubServer(() => errorResponse(404, 'node_not_found', 'Nothing exists there.'));
  const followed = await runCli(shellWords(suggested), { connect: server.connect });
  assert.notEqual(followed.code, 2, `"raphael ${suggested}" was refused:\n${followed.stderr}`);
};

/** Run one refusal, with nothing sent and nothing on stdout. */
const refused = async (argv: readonly string[]): Promise<Ran> => {
  const server = stubServer(() => {
    throw new Error('A refused command must not be sent.');
  });
  const raw = await runCli(argv, { connect: server.connect });
  const ran = {
    code: raw.code,
    stdout: raw.stdout.replaceAll(directory, '<tmp>'),
    stderr: raw.stderr.replaceAll(directory, '<tmp>'),
  };
  assert.equal(server.requests.length, 0, 'a usage refusal never reaches the server');
  assert.equal(ran.stdout, '', 'a refusal prints nothing on stdout');
  assert.equal(ran.code, 2, ran.stderr);
  return ran;
};

describe('local usage refusals', () => {
  for (const [name, how] of Object.entries(CASES)) {
    if ('unreachable' in how) {
      it.skip(`${name} cannot be produced: ${how.unreachable}`);
      continue;
    }
    it(`refuses ${name}`, async () => {
      const text = await refused(how.argv);
      usage.expectRun(caseName(name), text);
      await assertSuggestionParses(text.stderr);
      if (how.text === true) return;
      const json = await refused([...how.argv, '--json']);
      if (how.json === 'pin') {
        assertErrorDocument(json, { exit: 2, code: 'usage' });
        usage.expectRun(caseName(name, 'json'), json);
      } else {
        assertJsonMirrorsText(json, text, { exit: 2, code: 'usage' });
      }
    });
  }
});
