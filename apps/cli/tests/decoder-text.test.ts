import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * Cases that still reach the client's request decoder, because the CLI does not yet check that input
 * itself. DEBT: introduced in phase 02, paid back in phase 03, whose local validation through the
 * contracts' inspectors must empty this list and then remove the allowlist mechanism from this file.
 */
const STILL_DECODER_TEXT: readonly string[] = [
  // A blank title is decoded against the create union, which reports a type mismatch instead.
  'failures/kind-invalid_request.golden',
  'failures/kind-invalid_request-json.golden',
  'rules/title-title_required-area.golden',
  // Metadata and tag bounds are left to the decoder, which echoes the values.
  'rules/metadata-invalid_json-key-too-long.golden',
  'rules/metadata-invalid_json-too-deep.golden',
  'rules/metadata-too_large.golden',
  'rules/metadata-too_many_keys.golden',
  'rules/tags-tags_too_many.golden',
];

const goldenFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? goldenFiles(join(directory, entry.name))
      : [relative(GOLDEN_ROOT, join(directory, entry.name))],
  );

describe('decoder and schema text', () => {
  const files = goldenFiles(GOLDEN_ROOT);

  it('appears in no golden output outside the allowlist', () => {
    const offending = files.filter(
      (file) =>
        !STILL_DECODER_TEXT.includes(file) &&
        DECODER_TEXT.test(readFileSync(join(GOLDEN_ROOT, file), 'utf8')),
    );
    assert.deepEqual(offending, []);
  });

  it('still appears in every allowlisted case, so the list cannot outlive its debt', () => {
    for (const file of STILL_DECODER_TEXT) {
      const path = join(GOLDEN_ROOT, file);
      assert.ok(existsSync(path), `${file} is allowlisted but does not exist`);
      assert.match(
        readFileSync(path, 'utf8'),
        DECODER_TEXT,
        `${file} no longer has decoder text: remove it from the allowlist`,
      );
    }
  });
});
