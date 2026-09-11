import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import type { CanonicalDocument } from '../index.ts';
import { deriveText } from '../schema/text.ts';
import { fromMarkdown } from './import.ts';
import { MARKDOWN_NESTING_GUARD } from './parser.ts';

const imported = (markdown: string): CanonicalDocument => {
  const result = fromMarkdown(markdown);
  assert.ok(Either.isRight(result), `expected a document, got ${JSON.stringify(result)}`);
  return result.right;
};

const rejected = (markdown: string): { reason: string } => {
  const result = fromMarkdown(markdown);
  assert.ok(Either.isLeft(result), 'expected a rejection');
  return result.left;
};

const text = (markdown: string): string => deriveText(imported(markdown));

describe('fromMarkdown: supported content', () => {
  it('keeps inline marks inside ordered list items', () => {
    // The behaviour that the previous conversion stack lost: `**bold**` became literal text.
    const json = JSON.stringify(imported('1. **bold** item\n2. plain'));
    assert.ok(json.includes('"bold"'), json);
    assert.ok(!json.includes('**bold**'), json);
  });

  it('preserves a non-default ordered list start', () => {
    const json = JSON.stringify(imported('5. five\n6. six'));
    assert.ok(json.includes('"start":5'), json);
  });

  it('keeps structure for nested ordered and unordered lists', () => {
    assert.equal(text('- bullet\n  1. num\n- other'), 'bullet\nnum\nother');
    assert.equal(text('1. one\n   - a\n2. two'), 'one\na\ntwo');
  });

  it('supports headings, quote, rule, code and hard breaks', () => {
    const document = imported(
      '# h1\n\n## h2\n\n### h3\n\npara\n\n> quote\n\n---\n\n```mermaid\ngraph TD; A-->B;\n```',
    );
    const types = (document.content as { type: string }[]).map((node) => node.type);
    assert.deepEqual(types, [
      'heading',
      'heading',
      'heading',
      'paragraph',
      'blockquote',
      'horizontalRule',
      'codeBlock',
    ]);
  });

  it('keeps Mermaid as an ordinary language-labelled code block', () => {
    const json = JSON.stringify(imported('```mermaid\ngraph TD; A-->B;\n```'));
    assert.ok(json.includes('"language":"mermaid"'), json);
    assert.ok(json.includes('graph TD; A--&gt;B;') || json.includes('graph TD; A-->B;'), json);
  });

  it('treats empty and whitespace-only Markdown as the canonical empty document', () => {
    for (const source of ['', '   ', '\n\n  \n']) {
      assert.deepEqual(imported(source), { type: 'doc', content: [{ type: 'paragraph' }] });
    }
  });

  it('does not treat whitespace inside a fence as emptiness', () => {
    assert.equal(text('```\n   \n```'), '   ');
  });
});

describe('fromMarkdown: preservation of unsupported structure', () => {
  it('preserves a table as source rather than dropping it', () => {
    // The previous stack converted this to an empty document: structurally valid, entirely wrong.
    const source = '| a | b |\n| - | - |\n| 1 | 2 |';
    assert.equal(text(source), source);
  });

  it('preserves H4-H6 source instead of demoting the heading', () => {
    assert.equal(text('#### deep heading'), '#### deep heading');
  });

  it('preserves a fence whose info string carries more than a language token', () => {
    const source = '```js title="a.js"\nx\n```';
    assert.equal(text(source), source);
  });

  it('keeps task list markers as literal text in an ordinary list', () => {
    const document = imported('- [ ] todo\n- [x] done');
    const json = JSON.stringify(document);
    assert.ok(json.includes('bulletList'), json);
    assert.ok(!json.includes('taskList'), json);
    assert.equal(text('- [ ] todo\n- [x] done'), '[ ] todo\n[x] done');
  });

  it('keeps an inline image as literal source inside its paragraph', () => {
    // An inline element cannot become a code block without destroying the sentence around it.
    assert.equal(
      text('before ![alt](https://e.com/a.png) after'),
      'before ![alt](https://e.com/a.png) after',
    );
  });

  it('degrades a prohibited link to literal source rather than rejecting the import', () => {
    const document = imported('[click](javascript:alert(1))');
    const json = JSON.stringify(document);
    assert.ok(!json.includes('"link"'), json);
    assert.equal(text('[click](javascript:alert(1))'), '[click](javascript:alert(1))');
  });

  it('keeps a permitted link as a link mark', () => {
    const json = JSON.stringify(imported('[ok](https://example.com)'));
    assert.ok(json.includes('"link"'), json);
    assert.ok(json.includes('https://example.com'), json);
  });

  it('never produces executable HTML, and keeps the text', () => {
    for (const source of ['<div onclick="x()">hi</div>', 'a <script>alert(1)</script> b']) {
      const json = JSON.stringify(imported(source));
      assert.ok(!json.includes('"html"'), json);
      assert.ok(text(source).includes('script') || text(source).includes('div'), json);
    }
  });
});

describe('fromMarkdown: bounds', () => {
  it('rejects Markdown larger than the shared request budget', () => {
    const huge = 'x'.repeat(1024 * 1024 + 1);
    assert.equal(rejected(huge).reason, 'markdown_too_large');
  });

  it('rejects a document whose nesting reaches the parser guard', () => {
    const deep = Array.from({ length: 60 }, (_, index) => `${'  '.repeat(index)}- item`).join('\n');
    assert.equal(rejected(deep).reason, 'document_too_complex');
  });

  it('rejects deeply nested blockquotes at the guard', () => {
    assert.equal(rejected(`${'>'.repeat(400)} x`).reason, 'document_too_complex');
  });

  it('accepts nesting that stays within the supported depth', () => {
    const shallow = Array.from({ length: 5 }, (_, index) => `${'  '.repeat(index)}- item`).join(
      '\n',
    );
    assert.ok(Either.isRight(fromMarkdown(shallow)));
  });

  it('rejects an oversized inline run as complexity, not as a crash', () => {
    // markdown-it handles this input; an adapter that spread the result into push() would overflow.
    // The document genuinely exceeds our bounds, so the outcome is a clean complexity rejection.
    assert.equal(rejected('_a_ '.repeat(50_000)).reason, 'document_too_complex');
  });

  it('converts an inline run that stays within bounds', () => {
    const document = imported('_a_ '.repeat(1_000));
    assert.ok((document.content as unknown[]).length > 0);
  });

  it('does not overflow on long delimiter runs', () => {
    assert.ok(Either.isRight(fromMarkdown('*'.repeat(20_000) + 'x' + '*'.repeat(20_000))));
  });

  it('keeps the guard threshold below the parser nesting limit', () => {
    // The guard only works because it fires before the parser's own limit can discard input.
    assert.ok(MARKDOWN_NESTING_GUARD < 40);
  });
});
