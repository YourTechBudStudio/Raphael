import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * No output a person or an agent sees carries decoder or schema text.
 *
 * Every golden file is checked, which is every pinned help page, failure, and refusal. Text such as
 * `Expected "resource", actual "area"` is the request decoder speaking for the CLI: it names schema
 * internals, echoes what was typed, and never names the flag. ADR 0009 says the decoder is a backstop
 * that never speaks first.
 */

const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'golden');

/**
 * Fragments only a schema decoder or the runtime writes: Effect's messages and the tree its
 * formatter draws (`└─ ["title"]` then `└─ is missing`), a schema's own type text, and a raw Node
 * system error (`ENOENT: no such file or directory`) or exception name. The CLI's own sentences
 * never use these shapes: it says "A quoted phrase is missing its closing quote.", never a bare
 * `is missing` under a tree glyph.
 */
const DECODER_TEXT =
  /Expected |actual |is unexpected|[└├]─|ParseError|\breadonly \w+\??: |\bE[A-Z]{3,}: |fetch failed|\b(?:Type|Syntax|Range|Reference)Error\b|\berrno\b/u;

const goldenFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? goldenFiles(join(directory, entry.name))
      : [relative(GOLDEN_ROOT, join(directory, entry.name))],
  );

describe('decoder and schema text', () => {
  const files = goldenFiles(GOLDEN_ROOT);

  it('recognizes the shapes it guards against', () => {
    for (const text of [
      'Expected string, actual 1',
      '{ readonly title: string }\n└─ ["title"]\n   └─ is missing',
      "ENOENT: no such file or directory, open '/x/body.md'",
      'TypeError: fetch failed',
      '(FiberFailure) ParseError: bad',
    ]) {
      assert.ok(DECODER_TEXT.test(text), text);
    }
    for (const text of [
      'A quoted phrase is missing its closing quote.',
      'The body file at "/x" is not valid UTF-8.',
      'Could not connect to http://127.0.0.1:2: nothing is listening there.',
    ]) {
      assert.equal(DECODER_TEXT.test(text), false, text);
    }
  });

  it('appears in no golden output', () => {
    const offending = files.filter((file) =>
      DECODER_TEXT.test(readFileSync(join(GOLDEN_ROOT, file), 'utf8')),
    );
    assert.deepEqual(offending, []);
  });
});
