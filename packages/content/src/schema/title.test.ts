import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TITLE_MAX_CODE_POINTS } from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { fromMarkdown } from '../conversion/import.ts';
import { createEmptyDocument, type CanonicalDocument } from '../index.ts';
import { deriveTitle } from './title.ts';

const doc = (markdown: string): CanonicalDocument => {
  const result = fromMarkdown(markdown);
  assert.ok(Either.isRight(result), `expected a document, got ${JSON.stringify(result)}`);
  return result.right;
};

describe('deriveTitle', () => {
  it('takes the first non-empty body line, trimmed', () => {
    assert.equal(deriveTitle(doc('\n\n#   Launch plan  \n\nDetails'), 'ignored'), 'Launch plan');
  });

  it('falls back to the description when the body has no text', () => {
    assert.equal(
      deriveTitle(createEmptyDocument(), '\n  From the description \nmore'),
      'From the description',
    );
  });

  it('names nothing when neither has text', () => {
    assert.equal(deriveTitle(createEmptyDocument(), ' \n\t'), undefined);
  });

  it('uses code and Mermaid source like any other text', () => {
    assert.equal(deriveTitle(doc('```mermaid\ngraph TD; A-->B;\n```'), ''), 'graph TD; A-->B;');
  });

  it('cuts to the title bound by code point', () => {
    const long = '\u{1f525}'.repeat(TITLE_MAX_CODE_POINTS + 5);
    assert.equal(
      deriveTitle(createEmptyDocument(), long),
      '\u{1f525}'.repeat(TITLE_MAX_CODE_POINTS),
    );
  });

  it('leaves internal whitespace and case as written', () => {
    assert.equal(deriveTitle(createEmptyDocument(), 'Mixed   CASE title'), 'Mixed   CASE title');
  });
});
