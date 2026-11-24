import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import {
  DESCRIPTION_MAX_CODE_POINTS,
  LIST_LIMIT_MAX,
  SCOPES_MAX_COUNT,
  SEARCH_QUERIES_MAX_COUNT,
  SLUG_MAX_CODE_POINTS,
  TAGS_MAX_COUNT,
  TITLE_MAX_CODE_POINTS,
} from '@raphael/contracts/nodes';

import { COMMAND_DEFINITIONS } from '../src/main.ts';
import { runCli } from './support/cli.ts';

const ENVIRONMENT = {
  RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
  RAPHAEL_API_KEY: 'stub-key-0123456789abcdef0123456789',
};

const CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--id', ['get', '--id', '0']],
  ['--id', ['get', '--id', '-1']],
  ['--id', ['get', '--id', '1.5']],
  ['--id', ['get', '--id', '9007199254740992']],
  ['--parent-id', ['create', 'area', '--parent-id', '0', '--slug', 'work', '--title', 'Work']],
  ['--title', ['create', 'area', '/work', '--title', ' ']],
  ['--title', ['create', 'area', '/work', '--title', 'x'.repeat(TITLE_MAX_CODE_POINTS + 1)]],
  [
    '--description',
    [
      'create',
      'area',
      '/work',
      '--title',
      'Work',
      '--description',
      'x'.repeat(DESCRIPTION_MAX_CODE_POINTS + 1),
    ],
  ],
  ['--slug', ['create', 'area', '--slug', 'Work', '--title', 'Work']],
  ['--slug', ['create', 'area', '--slug', 'x'.repeat(SLUG_MAX_CODE_POINTS + 1), '--title', 'Work']],
  ['--tag', ['create', 'area', '/work', '--title', 'Work', '--tag', 'a,b']],
  ['--tag', ['create', 'area', '/work', '--title', 'Work', '--tag', 'a', '--tag', 'a']],
  [
    '--tag',
    [
      'create',
      'area',
      '/work',
      '--title',
      'Work',
      ...Array.from({ length: TAGS_MAX_COUNT + 1 }, (_, i) => ['--tag', `t${i}`]).flat(),
    ],
  ],
  ['--metadata', ['create', 'area', '/work', '--title', 'Work', '--metadata', '[]']],
  ['--metadata', ['create', 'area', '/work', '--title', 'Work', '--metadata', '@-']],
  ['--metadata', ['update', '/work', '--revision', '1', '--metadata', '{}']],
  ['--filter', ['list', '/', '--filter', '@-']],
  ['--filter', ['list', '/', '--filter', '{"type":"bad"}']],
  ['--filter', ['list', '/', '--filter', '{"kind":"bad"}']],
  ['--filter', ['list', '/', '--filter', '{"title":"private"}']],
  ['--limit', ['list', '/', '--limit', '0']],
  ['--limit', ['favorites', '--limit', String(LIST_LIMIT_MAX + 1)]],
  ['--skip', ['list', '/', '--skip', '-1']],
  ['--order-by', ['list', '/', '--order-by', 'title:asc']],
  ['--order-by', ['list', '/', '--order-by', 'slug:sideways']],
  ['--revision', ['update', '/work', '--revision', '0', '--title', 'Work']],
  ['--return-format', ['get', '/work', '--return-format', 'markdown']],
  ['--return-format', ['get', '/work', '--json', '--return-format', 'bad']],
  ['-r', ['search', '/', '-q', 'work', '-r']],
  ['-q', ['search', '/', '-q', ' ']],
  [
    '-q',
    [
      'search',
      '/',
      ...Array.from({ length: SEARCH_QUERIES_MAX_COUNT + 1 }, () => ['-q', 'work']).flat(),
    ],
  ],
  ['path', ['list', ...Array.from({ length: SCOPES_MAX_COUNT + 1 }, (_, i) => `/work${i}`)]],
];

describe('phase 03 invalid-input fuzz pass', () => {
  const refuse = async (
    argv: readonly string[],
    subject?: string,
    // The next step: help, or - when the refusal knows it - the exact fix, given in place of help.
    next: RegExp = /(?:^hint: |"hint":")(?:.*raphael .*--help|.*raphael help|For example: --|Use --\S+ on its own|Did you mean |Remove -|Give each tag its own --tag|Try ")/mu,
  ): Promise<void> => {
    let connections = 0;
    const ran = await runCli(argv, {
      environment: ENVIRONMENT,
      connect: () => {
        connections += 1;
        throw new Error('Invalid input reached network setup');
      },
    });
    assert.equal(ran.code, 2, `${argv.slice(0, 4).join(' ')}: ${ran.stderr}`);
    assert.equal(connections, 0, 'invalid input must fail before opening a connection');
    assert.equal(ran.stdout, '');
    if (subject !== undefined)
      assert.ok(ran.stderr.toLowerCase().includes(subject.toLowerCase()), ran.stderr);
    assert.match(ran.stderr, next);
    assert.doesNotMatch(ran.stderr, /Expected |actual |ERR_PARSE_ARGS_|ECONNREFUSED/u);
  };

  for (const command of ['update', 'move', 'archive', 'restore']) {
    it(`refuses an oversized convenience-read request on ${command} before connecting`, async () => {
      const target = `/${'a'.repeat(REQUEST_MAX_BYTES)}`;
      const args = command === 'update' ? ['--title', 'Work'] : command === 'move' ? ['/work'] : [];
      await refuse([command, target, ...args]);
    });
  }

  for (const [subject, argv] of CASES) {
    it(`refuses ${argv.slice(0, 4).join(' ')} before network setup`, async () => {
      await refuse(argv, subject);
    });
  }

  for (const definition of COMMAND_DEFINITIONS) {
    it(`rejects invalid positionals on ${definition.name}`, async () => {
      // Login's one positional is an address; its refusal names the fix and the login to run again.
      await refuse(
        [
          ...definition.name.split(' '),
          'not-an-absolute-path',
          ...(definition.name === 'search' ? ['-q', 'work'] : []),
        ],
        undefined,
        definition.name === 'login' ? /run "raphael login" again/u : undefined,
      );
    });
    it(`rejects unknown options on ${definition.name}`, async () => {
      await refuse([...definition.name.split(' '), '--definitely-invalid'], '--definitely-invalid');
    });
    for (const option of definition.options) {
      if (option.type === 'boolean' && option.name !== 'help') {
        it(`rejects invalid values for --${option.name} on ${definition.name}`, async () => {
          await refuse(
            [...definition.name.split(' '), `--${option.name}=--invalid-value`],
            `--${option.name}`,
          );
        });
      }
      if (option.type !== 'string') continue;
      it(`rejects missing --${option.name} on ${definition.name}`, async () => {
        await refuse([...definition.name.split(' '), `--${option.name}`], `--${option.name}`);
      });
    }
  }
});
