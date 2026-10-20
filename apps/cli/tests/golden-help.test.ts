import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { REMOTE_COMMAND_NAMES } from '../src/main.ts';
import { errorResponse, runCli, stubServer } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * Every help page, byte for byte, and every example in them, executed.
 *
 * The pages are compared with golden files rather than with the constants that produce them: a test
 * that compares a page with its own constant passes whatever the page says.
 */

const help = goldenSurface('help');

/** Each page once, by the spelling the golden file is named after. */
const PAGES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['root', ['--help']],
  ['server', ['server', '--help']],
  ['server-serve', ['server', 'serve', '--help']],
  ['login', ['login', '--help']],
  ...REMOTE_COMMAND_NAMES.map((name) => [name, [name, '--help']] as const),
];

/** Other spellings that must print exactly what the page's own spelling prints. */
const ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['root', []],
  ['root', ['-h']],
  ['root', ['help']],
  ['server', ['server']],
  ['server', ['server', '-h']],
  ['server-serve', ['server', 'serve', '-h']],
  ['login', ['login', '-h']],
  ...REMOTE_COMMAND_NAMES.map((name) => [name, [name, '-h']] as const),
];

after(() => assert.deepEqual(help.strays(), []));

describe('help pages', () => {
  for (const [name, argv] of PAGES) {
    it(`pins ${argv.join(' ')}`, async () => {
      help.expectRun(name, await runCli(argv));
    });
  }

  for (const [name, argv] of ALIASES) {
    it(`prints the same bytes for ${argv.length === 0 ? '(no arguments)' : argv.join(' ')}`, async () => {
      const page = PAGES.find(([pageName]) => pageName === name);
      assert.ok(page !== undefined);
      assert.deepEqual(await runCli(argv), await runCli(page[1]));
    });
  }
});

/**
 * Split an example line the way a POSIX shell would for the quoting help actually uses: single
 * quotes, double quotes, and bare words. Anything after a run of two or more spaces outside quotes is
 * the explanation printed beside the example, not part of it.
 */
const tokenize = (line: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === ' ') {
      if (line.charAt(index + 1) === ' ') break;
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  assert.equal(quote, undefined, `unbalanced quote in example: ${line}`);
  if (started) tokens.push(current);
  return tokens;
};

/**
 * Every line, on any page, that is an invocation someone could copy: it starts with `raphael` and has
 * no `<placeholder>` or `[optional]` part, which is what tells a usage line from an example. The root
 * page's title line is neither.
 */
const examplesOf = (page: string): string[][] =>
  page
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('raphael ') && !line.startsWith('raphael - '))
    .filter((line) => !/<[a-z][a-z-]*>|\[(?:-|options|changes)/.test(line))
    .map((line) => tokenize(line).slice(1));

describe('help examples', () => {
  // Examples read files relative to the current directory and from standard input, so each one runs
  // from a directory holding the files the examples name, with something on standard input.
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

  it('finds examples to run', async () => {
    const all = await Promise.all(PAGES.map(async ([, argv]) => (await runCli(argv)).stdout));
    // Seventeen today. A floor rather than an exact count, so adding an example is not a test change,
    // while an extraction rule that silently stopped matching is.
    assert.ok(all.flatMap(examplesOf).length >= 17);
  });

  for (const [name, argv] of PAGES) {
    it(`runs every example on the ${name} page until it reaches the server`, async () => {
      const page = (await runCli(argv)).stdout;
      for (const example of examplesOf(page)) {
        process.chdir(directory);
        Object.defineProperty(process, 'stdin', {
          configurable: true,
          value: Readable.from([Buffer.from('# From standard input\n')]),
        });
        // Any answer will do; reaching the server at all is what proves the example parses.
        const server = stubServer(() => errorResponse(503, 'storage_busy', 'Busy.'));
        const ran = await runCli(example, { connect: server.connect });
        assert.ok(
          server.requests.length > 0,
          `${caseName(name)}: "raphael ${example.join(' ')}" never reached the server:\n${ran.stderr}`,
        );
      }
    });
  }
});
