import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP_TOPICS } from '../src/help.ts';
import { COMMAND_DEFINITIONS } from '../src/main.ts';
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
    }
  });

  it('uses product vocabulary in every fixed failure message', () => {
    const root = join(here, 'golden');
    const offending: Record<string, readonly string[]> = {};
    for (const file of filesBelow(root)) {
      if (!file.endsWith('.golden') || file.includes('/help/')) continue;
      const text = readFileSync(file, 'utf8');
      const stderr = text.split('==== stderr ====\n')[1] ?? '';
      // JSON retains the original server message and structured details for diagnosis. Only the
      // CLI's own message and hint are copy; other fields contain machine tokens or submitted data.
      let copy = stderr;
      try {
        const document = JSON.parse(stderr) as { error?: { message: string; hint: string } };
        if (document.error !== undefined)
          copy = `${document.error.message}\n${document.error.hint}`;
      } catch {
        /* A human failure is already prose. */
      }
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

  it('does not restate contract-owned limits or closed lists in help sources', () => {
    const sources = [
      join(here, '../src/help.ts'),
      join(here, '../src/shared/help-rules.ts'),
      join(here, '../src/modules/nodes/commands.ts'),
    ];
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
    }
    const rules = readFileSync(sources[1]!, 'utf8');
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
