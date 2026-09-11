import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import type { CanonicalDocument } from '../index.ts';
import { toMarkdown } from './export.ts';
import { fromMarkdown } from './import.ts';

const imported = (markdown: string): CanonicalDocument => {
  const result = fromMarkdown(markdown);
  assert.ok(Either.isRight(result), `expected a document, got ${JSON.stringify(result)}`);
  return result.right;
};

/** Stability: repeated conversion stops changing the result. It does not imply fidelity. */
const assertStable = (markdown: string): void => {
  const first = toMarkdown(imported(markdown));
  const second = toMarkdown(imported(first));
  assert.equal(second, first, `unstable round trip for ${JSON.stringify(markdown)}`);
  const firstDocument = imported(first);
  assert.deepEqual(imported(second), firstDocument, 'document drifted across round trips');
};

describe('toMarkdown: fences', () => {
  it('sizes the fence above the longest backtick run in its content', () => {
    const document = imported('````\n```\ninner\n```\n````');
    const out = toMarkdown(document);
    assert.ok(out.startsWith('````'), out);
    assertStable('````\n```\ninner\n```\n````');
  });

  it('does not accumulate wrapping on preserved source containing a fence', () => {
    // The defect that made us own export: a three-backtick fence around three-backtick content.
    assertStable('```js title="a.js"\nx\n```');
  });

  it('keeps a preserved table stable across repeated conversions', () => {
    assertStable('| a | b |\n| - | - |\n| 1 | 2 |');
  });

  it('always emits at least three delimiters', () => {
    const out = toMarkdown(imported('```\nplain\n```'));
    assert.ok(/^`{3,}/u.test(out), out);
  });
});

describe('toMarkdown: HTML is never reactivated', () => {
  it('escapes HTML-looking text on the way out', () => {
    // Inert in storage is not the same as safe in someone else's renderer.
    const out = toMarkdown(imported('a <script>alert(1)</script> b'));
    assert.ok(!out.includes('<script>'), out);
    assert.ok(out.includes('script'), out);
  });

  it('escapes every angle bracket in block-looking HTML', () => {
    const out = toMarkdown(imported('<div onclick="x()">hi</div>'));
    // Every `<` and `>` must be backslash-escaped, so no renderer can read a tag back out of it.
    for (const [index, character] of [...out].entries()) {
      if (character === '<' || character === '>') {
        assert.equal(out[index - 1], '\\', `unescaped ${character} in ${out}`);
      }
    }
  });

  it('keeps HTML-looking text stable across repeated conversions', () => {
    assertStable('a <script>alert(1)</script> b');
    assertStable('<div onclick="x()">hi</div>');
  });
});

describe('toMarkdown: round trips', () => {
  const cases: Record<string, string> = {
    'ordered list with marks': '1. **bold** and *it*\n2. [link](https://example.com) and `x`',
    'ordered list start': '5. five\n6. six',
    'nested ordered in unordered': '- bullet\n  1. num one\n  2. num two\n- other',
    'nested unordered in ordered': '1. one\n   - a\n   - b\n2. two',
    headings: '# h1\n\n## h2\n\n### h3',
    blockquote: '> quoted text',
    'nested blockquote': '> outer\n>\n> > inner',
    'horizontal rule': 'before\n\n---\n\nafter',
    'code block': '```mermaid\ngraph TD; A-->B;\n```',
    'hard break': 'line one  \nline two',
    'preserved h4': '#### deep heading',
    'preserved table': '| a | b |\n| - | - |',
    'task markers': '- [ ] todo\n- [x] done',
    'inline image': 'before ![alt](https://e.com/a.png) after',
    'prohibited link': '[click](javascript:alert(1))',
    unicode: '# 日本語 — café\n\n**太字** and emoji 🎉',
    empty: '',
  };

  for (const [label, source] of Object.entries(cases)) {
    it(`is stable for ${label}`, () => {
      assertStable(source);
    });
  }
});

describe('toMarkdown: fidelity', () => {
  it('keeps task markers readable rather than reinterpreting them', () => {
    const out = toMarkdown(imported('- [ ] todo\n- [x] done'));
    // Brackets are escaped so they stay literal text; unescaped, they read as the markers they were.
    const unescaped = out.replaceAll('\\', '');
    assert.ok(unescaped.includes('[ ] todo'), out);
    assert.ok(unescaped.includes('[x] done'), out);
    assert.ok(!out.includes('taskList'), out);
  });

  it('keeps a permitted link clickable and a prohibited one literal', () => {
    assert.ok(toMarkdown(imported('[ok](https://example.com)')).includes('](https://example.com)'));
    const prohibited = toMarkdown(imported('[click](javascript:alert(1))'));
    // The brackets must be escaped, so no renderer reconstructs a javascript: link from this.
    assert.ok(prohibited.includes('\\[click\\]'), prohibited);
    assert.ok(!/(?<!\\)\]\(/u.test(prohibited), prohibited);
  });

  it('preserves code block content exactly, including internal whitespace', () => {
    const document = imported('```\n  indented\n\n  spaced\n```');
    const out = toMarkdown(document);
    assert.ok(out.includes('  indented'), out);
    assert.ok(out.includes('  spaced'), out);
  });
});
