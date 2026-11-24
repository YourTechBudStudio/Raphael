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
  for (const definition of COMMAND_DEFINITIONS) {
    it(`prints one identical help document for all ${definition.name} help spellings with --json`, async () => {
      const words = definition.name.split(' ');
      const expected = await runCli(['help', ...words, '--json']);
      assert.equal(expected.code, 0, expected.stderr);
      assert.equal(expected.stderr, '');
      const document = JSON.parse(expected.stdout) as { ok: boolean; command: string };
      assert.deepEqual(Object.keys(document), ['ok', 'command', 'definition']);
      assert.equal(document.ok, true);
      assert.equal(document.command, 'help');
      for (const argv of [
        ['help', '--json', ...words],
        [...words, '--help', '--json'],
        [...words, '--json', '--help'],
        [...words, '-h', '--json'],
      ]) {
        assert.deepEqual(await runCli(argv), expected, argv.join(' '));
      }
    });
  }
  for (const argv of [[], ['--help'], ['-h']]) {
    it(`prints root help for ${argv.join(' ') || 'no arguments'}`, async () => {
      assert.deepEqual(await runCli(argv), await runCli(['help']));
    });
  }
  it('prints one identical root help document for every spelling with --json', async () => {
    const expected = await runCli(['help', '--json']);
    assert.equal(expected.code, 0, expected.stderr);
    const document = JSON.parse(expected.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document), [
      'ok',
      'command',
      'commands',
      'topics',
      'examples',
      'exitCodes',
      'errorCodes',
    ]);
    assert.equal(document.command, 'help');
    for (const argv of [
      ['--help', '--json'],
      ['-h', '--json'],
      ['--json', '--help'],
      ['--json', '-h'],
      ['help', 'reference', '--json'],
    ]) {
      assert.deepEqual(await runCli(argv), expected, argv.join(' '));
    }
  });
  it('reports a help failure as the help command, as text and as JSON', async () => {
    for (const argv of [
      ['help', 'nope', '--json'],
      ['help', '--bogus', '--json'],
      ['--help', 'extra', '--json'],
      ['--json', '--help', 'extra'],
    ]) {
      const ran = await runCli(argv);
      assert.equal(ran.code, 2, argv.join(' '));
      assert.equal(ran.stdout, '');
      assert.equal((JSON.parse(ran.stderr) as { command: string }).command, 'help', argv.join(' '));
    }
  });
  it('publishes no member only the CLI reads in help --json', async () => {
    const ran = await runCli(['help', '--json']);
    const { commands } = JSON.parse(ran.stdout) as {
      commands: readonly (Record<string, unknown> & { options: readonly object[] })[];
    };
    for (const command of commands) {
      assert.equal('fieldFlags' in command, false);
      assert.equal('verifiesServer' in command, false);
      for (const option of command.options) assert.equal('changes' in option, false);
    }
  });
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
      assert.deepEqual(JSON.parse(ran.stdout), { ok: true, command: 'help', topic });
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
            transport: () => server.connect().transport,
            // The piped example's key, as `printf '%s\n' "$KEY"` would supply it.
            stdin: { isTTY: false, read: async () => Buffer.from(`${STUB_KEY}\n`) },
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
