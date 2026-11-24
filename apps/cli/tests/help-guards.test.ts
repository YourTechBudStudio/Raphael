import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIMEOUT_MS } from '@raphael/client';
import * as contracts from '@raphael/contracts';
import * as connection from '@raphael/contracts/connection';
import * as nodes from '@raphael/contracts/nodes';

import { HELP_TOPICS, HELP_WIDTH, ROOT_EXAMPLES, renderExample } from '../src/help.ts';
import { COMMAND_DEFINITIONS } from '../src/main.ts';
import { stateLabel } from '../src/shared/state-words.ts';
import { TIMEOUT_MAX_SECONDS } from '../src/shared/timeout.ts';
import { SERVER_KEY_FILE_RECIPE } from '../src/shared/variables.ts';
import { runCli, stubServer } from './support/cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
const forbidden = /\b(?:nodes?|entities|entity|selection|scopes?|canonical|selectors?)\b/giu;
const filesBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)],
  );

/** Machine field names remain the API contract; prose around them uses the product vocabulary. */
const prose = (text: string): string =>
  text
    .replace(/`(?:entity|node|items\[\]\.node)`/gu, 'item')
    .replace(/\bitems\[\]\.node\b/gu, 'items')
    .replace(/\buse (?:entity|node)(?=;)/gu, 'use item')
    .replace(/JSON carries (?:entity|node)(?=\.| and archiveCauses)/gu, 'JSON carries item')
    .replace(/"(?:entity|node|scopes|selector)"\s*:/gu, '"field":');

/** Every source that writes help or failure copy. */
const COPY_SOURCES = [
  'help.ts',
  'main.ts',
  'modules/help.ts',
  'modules/nodes/commands.ts',
  'modules/nodes/input.ts',
  'modules/connection/config.ts',
  'modules/connection/endpoint.ts',
  'modules/connection/failures.ts',
  'modules/connection/login.ts',
  'modules/connection/logout.ts',
  'modules/connection/remote.ts',
  'modules/connection/status.ts',
  'modules/server/serve.ts',
  'shared/args.ts',
  'shared/error-codes.ts',
  'shared/exit.ts',
  'shared/failure-wording.ts',
  'shared/help-rules.ts',
  'shared/state-words.ts',
  'shared/success.ts',
];

/**
 * The values of the contracts' numeric limits, and of the CLI's own timeout bounds, that are large
 * enough to be told apart from ordinary small numbers in copy ("Showing 1-3.", "exit 5").
 */
const LIMIT_VALUES: ReadonlySet<number> = new Set(
  [nodes, contracts, connection, { TIMEOUT_MAX_SECONDS, DEFAULT_TIMEOUT_MS }]
    .flatMap((module) => Object.values(module))
    .filter((value): value is number => typeof value === 'number')
    // A millisecond value is also written as seconds.
    .flatMap((value) => (value % 1000 === 0 ? [value, value / 1000] : [value]))
    .filter((value) => value >= 10),
);

/**
 * The literal text of every string in a TypeScript source: quoted strings, and template strings
 * without what they interpolate. Comments are skipped. Enough of a scanner for copy, not a parser.
 */
const literalText = (source: string): string[] => {
  const texts: string[] = [];
  let index = 0;
  const templateFrom = (start: number): number => {
    let text = '';
    let position = start;
    while (position < source.length && source[position] !== '`') {
      if (source[position] === '\\') {
        text += source.slice(position, position + 2);
        position += 2;
      } else if (source.startsWith('${', position)) {
        texts.push(text);
        text = '';
        position = codeFrom(position + 2, '}');
      } else {
        text += source[position];
        position += 1;
      }
    }
    texts.push(text);
    return position + 1;
  };
  const codeFrom = (start: number, close?: string): number => {
    let depth = 0;
    let position = start;
    while (position < source.length) {
      const character = source[position] as string;
      if (source.startsWith('//', position)) {
        position = source.indexOf('\n', position);
        if (position === -1) return source.length;
      } else if (source.startsWith('/*', position)) {
        position = source.indexOf('*/', position) + 2;
        if (position === 1) return source.length;
      } else if (character === '`') {
        position = templateFrom(position + 1);
      } else if (character === "'" || character === '"') {
        let end = position + 1;
        while (end < source.length && source[end] !== character && source[end] !== '\n') {
          end += source[end] === '\\' ? 2 : 1;
        }
        texts.push(source.slice(position + 1, end));
        position = end + 1;
      } else {
        if (character === '{') depth += 1;
        if (character === '}') {
          if (depth === 0 && close === '}') return position + 1;
          depth -= 1;
        }
        position += 1;
      }
    }
    return position;
  };
  index = codeFrom(index);
  return texts;
};

describe('phase 03 help and copy guards', () => {
  it('uses product vocabulary on every help page', async () => {
    const pages = [
      ['help'],
      ['help', 'reference'],
      ...COMMAND_DEFINITIONS.map(({ name }) => ['help', ...name.split(' ')]),
      ...HELP_TOPICS.map(({ name }) => ['help', name]),
    ];
    for (const argv of pages) {
      const ran = await runCli(argv);
      assert.equal(ran.code, 0, ran.stderr);
      assert.deepEqual(prose(ran.stdout).match(forbidden) ?? [], [], argv.join(' '));
      // One name for what an id is: the root page says "stable id", and so does every --id.
      assert.doesNotMatch(ran.stdout, /\b(?:durable|permanent|persistent) (?:id|identifier)/iu);
    }
  });

  it(`keeps every text help line within ${HELP_WIDTH} columns, except what is copied whole`, async () => {
    const exampleLines = new Set(
      [ROOT_EXAMPLES, ...[...COMMAND_DEFINITIONS, ...HELP_TOPICS].map((page) => page.examples)]
        .flat()
        .map((example) => `  ${renderExample(example)}`),
    );
    /**
     * The lines allowed past the width, and why. Each is copied and run as it is, so wrapping it
     * would break it: a usage line is one command shape, an example is a command to paste, and the
     * key-file recipe is one shell command with no place to break that still runs.
     */
    const unbreakable = (line: string): boolean =>
      line.startsWith('Usage: raphael ') ||
      /^ {7}raphael /u.test(line) ||
      exampleLines.has(line) ||
      line.includes(SERVER_KEY_FILE_RECIPE);
    const pages = [
      ['help'],
      ['help', 'reference'],
      ...COMMAND_DEFINITIONS.map(({ name }) => ['help', ...name.split(' ')]),
      ...HELP_TOPICS.map(({ name }) => ['help', name]),
    ];
    const over: string[] = [];
    for (const argv of pages) {
      const ran = await runCli(argv);
      assert.equal(ran.code, 0, ran.stderr);
      for (const line of ran.stdout.split('\n')) {
        if ([...line].length > HELP_WIDTH && !unbreakable(line))
          over.push(`${argv.join(' ')}: ${line}`);
      }
    }
    assert.deepEqual(over, []);
  });

  it('keeps help --json strings as written, without the text layout', async () => {
    const ran = await runCli(['help', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    const help = JSON.parse(ran.stdout) as {
      commands: readonly {
        behavior: readonly string[];
        options: readonly { description: string }[];
      }[];
    };
    const strings = help.commands.flatMap(({ behavior, options }) => [
      ...behavior,
      ...options.map(({ description }) => description),
    ]);
    assert.deepEqual(
      strings.filter((text) => text.includes('\n')),
      [],
    );
    assert.ok(strings.some((text) => [...text].length > HELP_WIDTH));
  });

  it('uses product vocabulary in every fixed message, on both streams and in sentence goldens', () => {
    const root = join(here, 'golden');
    const offending: Record<string, readonly string[]> = {};
    /**
     * The copy in one printed stream. A JSON document keeps machine tokens and submitted data, so
     * only the CLI's own words are copy: an error's message and hint, and each warning's message.
     * Anything else is printed prose, line by line.
     */
    const copyOf = (stream: string): string =>
      stream
        .split('\n')
        .map((line) => {
          try {
            const document = JSON.parse(line) as {
              error?: { message: string; hint: string };
              warnings?: readonly { message: string }[];
            };
            if (typeof document !== 'object' || document === null) return line;
            return [
              ...(document.error === undefined
                ? []
                : [document.error.message, document.error.hint]),
              ...(document.warnings ?? []).map(({ message }) => message),
            ].join('\n');
          } catch {
            return line;
          }
        })
        .join('\n');
    for (const file of filesBelow(root)) {
      if (file.includes('/help/')) continue;
      const text = readFileSync(file, 'utf8');
      let copy: string;
      if (file.endsWith('.txt')) copy = text;
      else if (file.endsWith('.golden')) {
        const [, afterOut = ''] = text.split('==== stdout ====\n');
        const [stdout = '', stderr = ''] = afterOut.split('==== stderr ====\n');
        copy = `${copyOf(stdout)}\n${copyOf(stderr)}`;
      } else continue;
      const matches = prose(copy).match(forbidden) ?? [];
      if (matches.length > 0) offending[file] = matches;
    }
    assert.deepEqual(offending, {});
  });

  it('maps a structured kind rejection to the create type argument', async () => {
    const server = stubServer(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_input',
              message: 'The request was refused.',
              details: { field: 'kind', reason: 'invalid' },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const ran = await runCli(
      ['create', 'resource.note', '/work/note', '--title', 'A note', '--json'],
      { connect: server.connect },
    );
    assert.equal(server.requests.length, 1);
    assert.equal(ran.code, 2, ran.stderr);
    const result = JSON.parse(ran.stderr) as { error: { field: string; message: string } };
    assert.equal(result.error.field, '<type>');
    assert.doesNotMatch(result.error.message, /--kind/u);
  });

  it('lists exactly the state words a row can print, in the output help', async () => {
    const words = [
      ...new Set(
        [false, true].flatMap((archived) =>
          [false, true].map((active) => stateLabel({ active, archived })),
        ),
      ),
    ];
    const listed = `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`;
    const ran = await runCli(['help', 'output']);
    assert.ok(
      ran.stdout.replaceAll(/\s+/gu, ' ').includes(`State is ${listed}, and comes`),
      ran.stdout,
    );
  });

  it('does not restate contract-owned limits or closed lists in help sources', () => {
    const sources = COPY_SOURCES.map((file) => join(here, '../src', file));
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /(?:at most|maximum|minimum|Default(?:s)?(?: to)?|default(?:s)?(?: to)?)\s+\d[\d,_]*/gu,
        file,
      );
      assert.doesNotMatch(
        source,
        /(?:Types|Kinds|Allowed type values|Allowed kind values):\s*(?:area|project|resource|note)\b/gu,
        file,
      );
      // However it is phrased, a limit written out as a number is restated: the number itself is
      // what drifts. Only the literal text of strings is read, never what they interpolate.
      const restated = literalText(source)
        .flatMap((text) => [...text.matchAll(/(?<![\w.-])\d[\d,_]*(?![\w.])/gu)])
        .map(([number]) => Number(number.replaceAll(/[,_]/gu, '')))
        .filter((value) => LIMIT_VALUES.has(value));
      assert.deepEqual(restated, [], `${file} writes out a contract limit`);
    }
    const rules = readFileSync(join(here, '../src/shared/help-rules.ts'), 'utf8');
    for (const constant of [
      'NODE_TYPES',
      'RESOURCE_KINDS',
      'CONTAINER_TYPES',
      'PARENTAGE',
      'SLUG_GRAMMAR_DESCRIPTION',
      'SLUG_MAX_CODE_POINTS',
      'TITLE_MAX_CODE_POINTS',
      'DESCRIPTION_MAX_CODE_POINTS',
      'TAGS_MAX_COUNT',
      'METADATA_MAX_DEPTH',
      'LIST_LIMIT_DEFAULT',
      'LIST_LIMIT_MIN',
      'LIST_LIMIT_MAX',
      'FILTER_KEYS',
      'SEARCH_QUERY_MAX_CODE_POINTS',
      'SEARCH_QUERY_MAX_TERMS',
      'SEARCH_QUERIES_MAX_COUNT',
      'SCOPES_MAX_COUNT',
      'REQUEST_MAX_BYTES',
      'SUPPORTED_HEADING_LEVELS',
    ]) {
      assert.ok(rules.split(constant).length >= 3, `${constant} must be imported and rendered`);
    }
  });
});
