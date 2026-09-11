import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { toMarkdown } from '../src/conversion/export.ts';
import { fromMarkdown } from '../src/conversion/import.ts';
import { deriveText } from '../src/schema/text.ts';

/**
 * Golden fixtures. Expected results are authored and reviewed deliberately rather than generated
 * from the implementation under test, so a behaviour change shows up as a reviewable diff — which is
 * what makes a parser or lockfile upgrade a decision rather than a surprise.
 *
 * These cover fidelity: the result still contains the original supported content. Stability —
 * repeated conversion stops changing the result — is asserted separately, because a lossy conversion
 * can be perfectly stable.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures');

const read = (directory: string, file: string): string | undefined => {
  const path = join(FIXTURES, directory, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

describe('golden fixtures', () => {
  const directories = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(directories.length > 0, 'expected fixture directories');

  for (const directory of directories) {
    describe(directory, () => {
      const input = read(directory, 'input.md');
      assert.ok(input !== undefined, `${directory} has no input.md`);

      const result = fromMarkdown(input);
      assert.ok(Either.isRight(result), `${directory} failed to convert`);
      const document = result.right;

      const expectedDocument = read(directory, 'expected-document.json');
      if (expectedDocument !== undefined) {
        it('converts to the expected document', () => {
          assert.deepEqual(document, JSON.parse(expectedDocument));
        });
      }

      const expectedExport = read(directory, 'expected-export.md');
      if (expectedExport !== undefined) {
        it('exports the expected Markdown', () => {
          assert.equal(toMarkdown(document), expectedExport);
        });
      }

      const expectedText = read(directory, 'expected-text.txt');
      if (expectedText !== undefined) {
        it('derives the expected plain text', () => {
          assert.equal(deriveText(document), expectedText);
        });
      }

      it('is stable across repeated conversion', () => {
        const once = toMarkdown(document);
        const twice = toMarkdown(
          (() => {
            const second = fromMarkdown(once);
            assert.ok(Either.isRight(second));
            return second.right;
          })(),
        );
        assert.equal(twice, once);
      });
    });
  }
});
