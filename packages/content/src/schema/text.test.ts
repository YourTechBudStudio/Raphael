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

/**
 * The separator between blocks is generated; the newlines inside a block are authored. Removing the
 * global collapse made that distinction real, so it is pinned here rather than left to the comment
 * at the top of the module.
 */
describe('deriveText: generated separators versus authored newlines', () => {
  it('keeps every blank line a code block actually contains', () => {
    assert.equal(text('```\na\n\n\nb\n```'), 'a\n\n\nb');
  });

  it('keeps blank lines in Mermaid source, which is what the fixture was written for', () => {
    assert.equal(text('```mermaid\ngraph TD;\n\n  A-->B;\n```'), 'graph TD;\n\n  A-->B;');
  });

  it('joins two adjacent paragraphs with exactly one newline', () => {
    assert.equal(text('first\n\nsecond'), 'first\nsecond');
  });

  it('does not add a separator after content that already ends in one', () => {
    // The code block's own trailing newline is the boundary; the generated one would double it.
    const code = (source: string): unknown => ({
      type: 'codeBlock',
      attrs: { language: null },
      content: [{ type: 'text', text: source }],
    });
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'b' }] };
    const derive = (source: string): string =>
      deriveText({ type: 'doc', content: [code(source), paragraph] } as never);

    // One authored newline supplies the boundary, so no separator is generated.
    assert.equal(derive('a\n'), 'a\nb');
    // Two authored newlines are authored content: suppressing the generated separator must not
    // reach inside them.
    assert.equal(derive('a\n\n'), 'a\n\nb');
    // None, and the separator is generated as usual.
    assert.equal(derive('a'), 'a\nb');
  });

  it('keeps a run of hard breaks, which is authored and not generated', () => {
    const result = fromMarkdown('one\\\n\\\ntwo');
    assert.ok(Either.isRight(result));
    assert.equal(deriveText(result.right), 'one\n\ntwo');
  });

  it('gives an empty paragraph no line of its own', () => {
    // An empty block contributes no text, so it contributes no separator either. The paragraph
    // itself is untouched in canonical storage; this is extraction, not deletion.
    const result = fromMarkdown('a\n\nb');
    assert.ok(Either.isRight(result));
    const document = result.right as unknown as { content: unknown[] };
    const withEmpty = {
      type: 'doc',
      content: [document.content[0], { type: 'paragraph' }, document.content[1]],
    };
    assert.equal(deriveText(withEmpty as never), 'a\nb');
  });

  it('derives one line per item from nested lists', () => {
    assert.equal(
      text('- one\n  - one a\n    - one a i\n  - one b\n- two'),
      'one\none a\none a i\none b\ntwo',
    );
  });

  it('still trims newlines at the two document edges', () => {
    // Deliberate: derived text is search input. Canonical storage and fenced Markdown source
    // preservation are separate obligations and neither is weakened by this trim.
    assert.equal(text('```\n\na\n\n```'), 'a');
  });
});
