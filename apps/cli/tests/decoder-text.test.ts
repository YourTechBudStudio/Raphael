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

/** Fragments only a schema decoder writes. */
const DECODER_TEXT = /Expected |actual |is unexpected/u;

const goldenFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? goldenFiles(join(directory, entry.name))
      : [relative(GOLDEN_ROOT, join(directory, entry.name))],
  );

describe('decoder and schema text', () => {
  const files = goldenFiles(GOLDEN_ROOT);

  it('appears in no golden output', () => {
    const offending = files.filter((file) =>
      DECODER_TEXT.test(readFileSync(join(GOLDEN_ROOT, file), 'utf8')),
    );
    assert.deepEqual(offending, []);
  });
});
