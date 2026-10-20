import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { HELP_TOPICS, ROOT_EXAMPLES } from '../src/help.ts';
import { COMMAND_DEFINITIONS, REMOTE_COMMAND_NAMES } from '../src/main.ts';
import { runLogin } from '../src/modules/connection/login.ts';
import { parseServeArgs } from '../src/modules/server/serve.ts';
import { newSession } from '../src/shared/command.ts';
import { errorResponse, runCli, STUB_ENDPOINT, STUB_KEY, stubServer } from './support/cli.ts';
import { goldenSurface } from './support/golden.ts';

const help = goldenSurface('help');
const PAGES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['root', ['help']],
  ['reference', ['help', 'reference']],
  ...COMMAND_DEFINITIONS.map(
    (definition) =>
      [definition.name.replaceAll(' ', '-'), ['help', ...definition.name.split(' ')]] as const,
  ),
  ...HELP_TOPICS.map((topic) => [topic.name, ['help', topic.name]] as const),
];

after(() => assert.deepEqual(help.strays(), []));

describe('help pages', () => {
  for (const [name, argv] of PAGES) {
    it(`pins ${argv.join(' ')}`, async () => {
      help.expectRun(name, await runCli(argv));
    });
  }
  for (const definition of COMMAND_DEFINITIONS) {
    it(`prints identical bytes for all ${definition.name} help spellings`, async () => {
      const words = definition.name.split(' ');
      const expected = await runCli(['help', ...words]);
      assert.equal(expected.code, 0, expected.stderr);
      assert.deepEqual(await runCli([...words, '--help']), expected);
      assert.deepEqual(await runCli([...words, '-h']), expected);
    });
  }
  for (const argv of [[], ['--help'], ['-h']]) {
    it(`prints root help for ${argv.join(' ') || 'no arguments'}`, async () => {
      assert.deepEqual(await runCli(argv), await runCli(['help']));
    });
  }
  it('has no overlapping command and topic names', () => {
    const names = new Set(COMMAND_DEFINITIONS.map((definition) => definition.name));
    assert.deepEqual(
      HELP_TOPICS.filter((topic) => names.has(topic.name)),
      [],
    );
  });
  for (const topic of HELP_TOPICS) {
    it(`returns the full ${topic.name} topic as JSON`, async () => {
      const ran = await runCli(['help', '--json', topic.name]);
      assert.equal(ran.code, 0, ran.stderr);
      assert.deepEqual(JSON.parse(ran.stdout), topic);
    });
  }
  it('returns the aggregate reference as JSON', async () => {
    const reference = await runCli(['help', '--json', 'reference']);
    const aggregate = await runCli(['help', '--json']);
    assert.equal(reference.code, 0, reference.stderr);
    assert.deepEqual(JSON.parse(reference.stdout), JSON.parse(aggregate.stdout));
    const result = JSON.parse(reference.stdout) as {
      commands: readonly { name: string }[];
      topics: readonly { name: string }[];
    };
    assert.deepEqual(
      result.commands.map(({ name }) => name),
      COMMAND_DEFINITIONS.map(({ name }) => name),
    );
    assert.deepEqual(
      result.topics.map(({ name }) => name),
      [...HELP_TOPICS.map(({ name }) => name), 'reference'],
    );
  });
  it('offers machine definitions offline and has no separate search topic', async () => {
    const ran = await runCli(['help', '--json']);
    assert.equal(ran.code, 0, ran.stderr);
    const result = JSON.parse(ran.stdout) as { topics: readonly { name: string }[] };
    assert.equal(
      result.topics.some((topic) => topic.name === 'search'),
      false,
    );
  });
});

describe('structured help examples', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-examples-')));
  writeFileSync(join(directory, 'note.md'), '# A note\n');
  writeFileSync(join(directory, 'contracts.md'), '# Contracts\n');
  const previous = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');

  after(() => {
    process.chdir(previous);
    if (stdin !== undefined) Object.defineProperty(process, 'stdin', stdin);
    rmSync(directory, { recursive: true, force: true });
  });

  const groups = [
    { name: 'root', examples: ROOT_EXAMPLES },
    ...COMMAND_DEFINITIONS,
    ...HELP_TOPICS,
  ];

  for (const group of groups) {
    it(`executes the ${group.name} example data`, async () => {
      for (const { argv } of group.examples) {
        assert.equal(
          argv.some((word) => /<[a-z][a-z-]*>|\[options\]/u.test(word)),
          false,
        );
        process.chdir(directory);
        Object.defineProperty(process, 'stdin', {
          configurable: true,
          value: Readable.from([Buffer.from('# From standard input\n')]),
        });
        if (argv[0] === 'server' && argv[1] === 'serve') {
          parseServeArgs(argv.slice(2));
        } else if (argv[0] === 'login') {
          const server = stubServer(
            () =>
              new Response(JSON.stringify({ protocolVersion: PROTOCOL_VERSION }), {
                headers: { 'content-type': 'application/json' },
              }),
          );
          let output = '';
          const code = await runLogin(argv.slice(1), {
            streams: {
              out: (text) => {
                output += text;
              },
              err: (text) => {
                output += text;
              },
            },
            session: newSession({ command: 'login', writes: true, json: argv.includes('--json') }),
            prompter: () => ({
              ask: async () => STUB_ENDPOINT,
              askHidden: async () => STUB_KEY,
              close: () => {},
            }),
            environment: { HOME: directory, XDG_CONFIG_HOME: join(directory, 'config') },
            platform: 'linux',
            transport: server.connect,
          });
          assert.equal(code, 0, output);
          assert.equal(server.requests.length, 1);
        } else if (
          REMOTE_COMMAND_NAMES.includes(argv[0] as (typeof REMOTE_COMMAND_NAMES)[number])
        ) {
          const server = stubServer(() => errorResponse(503, 'storage_busy', 'Busy.'));
          const ran = await runCli(argv, { connect: server.connect });
          assert.ok(
            server.requests.length > 0,
            `${group.name}: raphael ${argv.join(' ')}\n${ran.stderr}`,
          );
        } else {
          const ran = await runCli(argv);
          assert.equal(ran.code, 0, `${group.name}: ${ran.stderr}`);
        }
      }
    });
  }
});
