import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { fromMarkdown } from '../conversion/import.ts';
import { createEmptyDocument } from '../index.ts';
import { deriveText } from './text.ts';

const text = (markdown: string): string => {
  const result = fromMarkdown(markdown);
  assert.ok(Either.isRight(result), `expected a document, got ${JSON.stringify(result)}`);
  return deriveText(result.right);
};

/**
 * These are the current extraction semantics. The search story may revise them deliberately and
 * rebuild derived indexes; that is a fixture update with recorded reasoning, not a silent change.
 */
describe('deriveText', () => {
  it('returns nothing for the empty document', () => {
    assert.equal(deriveText(createEmptyDocument()), '');
  });

  it('separates blocks with newlines', () => {
    assert.equal(text('# Title\n\nBody text\n\nMore'), 'Title\nBody text\nMore');
  });

  it('includes code and Mermaid source', () => {
    assert.equal(text('```mermaid\ngraph TD; A-->B;\n```'), 'graph TD; A-->B;');
    assert.equal(text('```js\nconst x = 1;\n```'), 'const x = 1;');
  });

  it('preserves whitespace inside code exactly', () => {
    assert.equal(text('```\n  indented\n    more\n```'), '  indented\n    more');
  });

  it('includes link text but not the destination', () => {
    assert.equal(text('see [the docs](https://example.com) now'), 'see the docs now');
  });

  it('turns hard breaks into newlines', () => {
    assert.equal(text('line one  \nline two'), 'line one\nline two');
  });

  it('gives a horizontal rule a boundary rather than decorative characters', () => {
    const derived = text('before\n\n---\n\nafter');
    assert.equal(derived, 'before\nafter');
    assert.ok(!derived.includes('-'), derived);
  });

  it('keeps list items on separate lines', () => {
    assert.equal(text('- one\n- two\n- three'), 'one\ntwo\nthree');
  });

  it('does not collapse whitespace inside a paragraph', () => {
    assert.equal(text('a  b\ttab'), 'a  b\ttab');
  });

  it('includes text from nested structures', () => {
    assert.equal(text('> quoted\n>\n> - item'), 'quoted\nitem');
  });

  it('includes preserved source so unsupported content stays searchable', () => {
    assert.equal(text('| a | b |\n| - | - |'), '| a | b |\n| - | - |');
  });

  it('keeps marked text without its delimiters', () => {
    assert.equal(text('**bold** and *italic* and `code`'), 'bold and italic and code');
  });
});
