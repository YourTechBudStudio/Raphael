import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { toMarkdown } from '../src/conversion/export.ts';
import { fromMarkdown } from '../src/conversion/import.ts';
import { canonicalizeDocument } from '../src/schema/canonicalize.ts';

/**
 * Export fidelity, driven from hand-authored canonical documents.
 *
 * The stability tests in `export.test.ts` start from Markdown and compare the second conversion with
 * the third, so any loss in the *first* conversion is invisible to them by construction. These cases
 * start where a stored body starts — a canonical document — and assert that exporting and
 * re-importing returns the same document.
 *
 * This is the property that matters for stored content: a body written through the editor may hold
 * any text a person can type, including every character Markdown gives meaning to.
 */

const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });
const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]): unknown =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const code = (value: string): unknown => text(value, [{ type: 'code' }]);
const link = (value: string, href: string): unknown =>
  text(value, [{ type: 'link', attrs: { href } }]);

const canonical = (input: unknown): unknown => {
  const result = canonicalizeDocument(input);
  assert.ok(Either.isRight(result), `not canonical: ${JSON.stringify(result)}`);
  return result.right;
};

/** Exporting a stored document and re-importing it must return the same document. */
const assertRoundTrip = (input: unknown, label: string): void => {
  const original = canonical(input);
  const markdown = toMarkdown(original as never);
  const reimported = fromMarkdown(markdown);
  assert.ok(
    Either.isRight(reimported),
    `${label}: re-import failed for ${JSON.stringify(markdown)}`,
  );
  assert.deepEqual(
    reimported.right,
    original,
    `${label}: round trip changed the document via ${JSON.stringify(markdown)}`,
  );
};

describe('canonical document survives export and re-import', () => {
  const cases: Record<string, unknown> = {
    'plain text': doc(para(text('hello world'))),
    'text with underscores': doc(para(text('snake_case_name'))),
    'text with asterisks': doc(para(text('2 * 3 * 4'))),
    'text with brackets': doc(para(text('an [example] here'))),
    'text with backslash': doc(para(text('a\\b'))),
    'text with angle brackets': doc(para(text('a < b > c & d'))),
    'text that looks like a bullet': doc(para(text('- not a list'))),
    'text that looks like an ordered list': doc(para(text('1. not a list'))),
    'text that looks like a paren list': doc(para(text('1) not a list'))),
    'text that looks like a heading': doc(para(text('# not a heading'))),
    'text that looks like a quote': doc(para(text('> not a quote'))),
    'text that looks like a rule': doc(para(text('---'))),
    'text that looks like a setext underline': doc(para(text('==='))),
    'code span': doc(para(code('const x = 1;'))),
    'code span with a backtick': doc(para(code('a`b'))),
    'code span with a double backtick': doc(para(code('a``b'))),
    'code span starting with a backtick': doc(para(code('`a'))),
    'code span of only a backtick': doc(para(code('`'))),
    'code span with surrounding spaces': doc(para(code(' padded '))),
    'code span with markdown inside': doc(para(code('**not bold**'))),
    'bold text': doc(para(text('bold', [{ type: 'bold' }]))),
    'italic text': doc(para(text('it', [{ type: 'italic' }]))),
    'strike text': doc(para(text('gone', [{ type: 'strike' }]))),
    'plain link': doc(para(link('x', 'https://example.com'))),
    'link with query and fragment': doc(para(link('x', 'https://example.com/a?b=c#d'))),
    'link with parentheses': doc(para(link('x', 'https://example.com/a)b'))),
    'link with nested parentheses': doc(para(link('x', 'https://en.wikipedia.org/wiki/A_(b)'))),
    'mailto link': doc(para(link('mail', 'mailto:a@b.com'))),
    'mixed inline': doc(
      para(text('a '), text('b', [{ type: 'bold' }]), text(' c '), code('d'), text(' e')),
    ),
    heading: doc({ type: 'heading', attrs: { level: 2 }, content: [text('Title')] }),
    'heading with marks': doc({
      type: 'heading',
      attrs: { level: 3 },
      content: [text('Bold', [{ type: 'bold' }])],
    }),
    'code block': doc({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [text('const x = 1;')],
    }),
    'code block with fence inside': doc({
      type: 'codeBlock',
      attrs: { language: null },
      content: [text('```\ninner\n```')],
    }),
    'code block with blank lines': doc({
      type: 'codeBlock',
      attrs: { language: null },
      content: [text('a\n\nb')],
    }),
    'horizontal rule': doc(para(text('before')), { type: 'horizontalRule' }, para(text('after'))),
    'hard break': doc(para(text('one'), { type: 'hardBreak' }, text('two'))),
    blockquote: doc({ type: 'blockquote', content: [para(text('quoted'))] }),
    'bullet list': doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('one'))] },
        { type: 'listItem', content: [para(text('two'))] },
      ],
    }),
    'ordered list': doc({
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [para(text('one'))] },
        { type: 'listItem', content: [para(text('two'))] },
      ],
    }),
    'ordered list with start': doc({
      type: 'orderedList',
      attrs: { start: 5 },
      content: [
        { type: 'listItem', content: [para(text('five'))] },
        { type: 'listItem', content: [para(text('six'))] },
      ],
    }),
    'list item with marks': doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para(text('b', [{ type: 'bold' }]))] }],
    }),
    unicode: doc(para(text('日本語 — café 🎉'))),
    'empty document': doc({ type: 'paragraph' }),
  };

  for (const [label, input] of Object.entries(cases)) {
    it(`survives: ${label}`, () => {
      assertRoundTrip(input, label);
    });
  }
});

describe('inline text cannot hold a line break', () => {
  it('rejects a newline in inline text', () => {
    // There is no Markdown encoding for it and `hardBreak` is how a break is expressed, so storing
    // one would create a document that cannot be exported without changing it.
    const result = canonicalizeDocument(doc(para(text('a\nb'))));
    assert.ok(Either.isLeft(result));
    assert.equal(result.left.reason, 'invalid_text');
  });

  it('still allows line breaks inside a code block', () => {
    assert.ok(
      Either.isRight(
        canonicalizeDocument(
          doc({ type: 'codeBlock', attrs: { language: null }, content: [text('a\nb')] }),
        ),
      ),
    );
  });
});

describe('boundary whitespace survives', () => {
  /**
   * Markdown strips whitespace at the edges of a block's lines, and four leading spaces change a
   * paragraph into a code block. Numeric character references are decoded back into the same
   * characters by the configured parser, so this text is representable after all — an earlier round
   * recorded it as an inherent limit on the strength of a measurement that read the wrong field.
   */
  const cases: Record<string, unknown> = {
    'one leading space': doc(para(text(' one space'))),
    'three leading spaces': doc(para(text('   three spaces'))),
    'four leading spaces': doc(para(text('    four spaces'))),
    'eight leading spaces': doc(para(text('        eight spaces'))),
    'trailing space': doc(para(text('trailing '))),
    'two trailing spaces': doc(para(text('trailing  '))),
    'leading tab': doc(para(text('\ttabbed'))),
    'trailing tab': doc(para(text('tabbed\t'))),
    'leading and trailing': doc(para(text('  both  '))),
    'only spaces': doc(para(text('   '))),
    'internal whitespace': doc(para(text('a  b\tc'))),
    'heading with leading space': doc({
      type: 'heading',
      attrs: { level: 2 },
      content: [text('  indented title')],
    }),
    'list item with leading space': doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para(text('  padded item'))] }],
    }),
    'blockquote with leading space': doc({
      type: 'blockquote',
      content: [para(text('  padded quote'))],
    }),
    'marked text with leading space': doc(para(text('  bold', [{ type: 'bold' }]))),
    'whitespace beside a code span': doc(para(text('  '), code('x'))),
    'literal entity text': doc(para(text('&#32;not a space'))),
  };

  for (const [label, input] of Object.entries(cases)) {
    it(`survives: ${label}`, () => {
      assertRoundTrip(input, label);
    });
  }
});

describe('link destinations survive', () => {
  /**
   * The parser's default link normalization percent-encoded destinations on import, so the stored
   * href depended on how the document arrived. These drive from the accepted URL policy rather than
   * from a handful of characters.
   */
  const hrefs = [
    'https://example.com',
    'https://example.com/',
    'https://example.com/a?b=c#d',
    'https://example.com/?a=1&b=2',
    'https://example.com/?x=&copy;',
    'https://example.com/a&amp;b',
    'https://example.com/a)b',
    'https://en.wikipedia.org/wiki/A_(b)',
    'https://example.com/a(b',
    String.raw`https://example.com/a\b`,
    'https://example.com/a[b]',
    'https://example.com/a`b',
    'https://example.com/a*b',
    'https://example.com/a_b',
    'https://example.com/a~b',
    'https://example.com/a#b',
    'https://example.com/a%20b',
    'https://example.com/\u00e4',
    'https://example.com/path/to/a.html?q=1&r=2#frag',
    'mailto:someone@example.com',
    'http://example.com:8080/a',
  ];

  for (const href of hrefs) {
    it(`survives: ${href}`, () => {
      assertRoundTrip(doc(para(link('x', href))), href);
    });
  }

  it('keeps an image destination and title intact', () => {
    const result = fromMarkdown('![alt](https://e.com/a.png "cap)tion")');
    assert.ok(Either.isRight(result));
    const once = toMarkdown(result.right);
    const twice = fromMarkdown(once);
    assert.ok(Either.isRight(twice));
    assert.deepEqual(twice.right, result.right);
  });
});

describe('systematic round-trip sweep', () => {
  /**
   * The two previous rounds each fixed the reported cases and missed neighbouring ones of the same
   * class — an ATX heading run (`##` re-imported as an empty heading) and a code span of ` \t `
   * (CommonMark strips the padding spaces because the content is not made up entirely of spaces).
   * Enumerating the space is what finds those, so the sweep is maintained rather than run once.
   */
  const PUNCTUATION = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'];
  const WHITESPACE = [' ', '  ', '   ', '    ', '\t', '\t\t', ' \t ', '\t \t', '  \t'];
  const MARK_SETS: (unknown[] | undefined)[] = [
    undefined,
    [{ type: 'bold' }],
    [{ type: 'italic' }],
    [{ type: 'strike' }],
    [{ type: 'code' }],
    [{ type: 'bold' }, { type: 'italic' }],
    [{ type: 'link', attrs: { href: 'https://e.com' } }],
  ];

  const sweep = (label: string, shapes: string[]): void => {
    it(label, () => {
      let checked = 0;
      for (const shape of shapes) {
        for (const marks of MARK_SETS) {
          const input = doc(para(text(shape, marks)));
          if (Either.isLeft(canonicalizeDocument(input))) continue;
          assertRoundTrip(input, `${JSON.stringify(shape)} with ${JSON.stringify(marks)}`);
          checked += 1;
        }
      }
      assert.ok(checked > 0, 'swept nothing');
    });
  };

  sweep(
    'every ASCII punctuation character, in runs and in context',
    PUNCTUATION.flatMap((character) =>
      [1, 2, 3, 7].flatMap((count) => {
        const run = character.repeat(count);
        return [run, `${run}a`, `a${run}`, `${run}a${run}`];
      }),
    ),
  );

  sweep(
    'whitespace at every edge',
    WHITESPACE.flatMap((space) => [`${space}a`, `a${space}`, `${space}a${space}`, space]),
  );

  it('survives block-construct lookalikes in every block context', () => {
    const shapes = [
      '  x',
      'x  ',
      '- x',
      '1. x',
      '# x',
      '#',
      '##',
      '###',
      '> x',
      '>>x',
      '---',
      '===',
      '```',
      '    x',
      '+ x',
      '* x',
      '\tx',
    ];
    const contexts: [string, (shape: string) => unknown][] = [
      ['paragraph', (shape) => doc(para(text(shape)))],
      ['heading', (shape) => doc({ type: 'heading', attrs: { level: 2 }, content: [text(shape)] })],
      ['blockquote', (shape) => doc({ type: 'blockquote', content: [para(text(shape))] })],
      [
        'bulletList',
        (shape) =>
          doc({
            type: 'bulletList',
            content: [{ type: 'listItem', content: [para(text(shape))] }],
          }),
      ],
      [
        'orderedList',
        (shape) =>
          doc({
            type: 'orderedList',
            attrs: { start: 3 },
            content: [{ type: 'listItem', content: [para(text(shape))] }],
          }),
      ],
      [
        'codeBlock',
        (shape) => doc({ type: 'codeBlock', attrs: { language: null }, content: [text(shape)] }),
      ],
    ];
    for (const shape of shapes) {
      for (const [name, build] of contexts) {
        const input = build(shape);
        if (Either.isLeft(canonicalizeDocument(input))) continue;
        assertRoundTrip(input, `${name} ${JSON.stringify(shape)}`);
      }
    }
  });
});

describe('cross-node inline transitions', () => {
  /**
   * Each earlier sweep built paragraphs from a single text node, so delimiter-flanking context — what
   * sits immediately before and after a marked run — was never exercised. These build paragraphs from
   * adjacent plain and marked runs, which is ordinary editor output.
   */
  const MARK_SETS: Record<string, unknown[]> = {
    bold: [{ type: 'bold' }],
    italic: [{ type: 'italic' }],
    strike: [{ type: 'strike' }],
    code: [{ type: 'code' }],
    link: [{ type: 'link', attrs: { href: 'https://e.com' } }],
    'bold+italic': [{ type: 'bold' }, { type: 'italic' }],
  };
  const MIDDLES = ['y', ' y ', ' y', 'y ', '  y  ', 'a b', '   '];
  const NEIGHBOURS = ['x', 'x ', ' x', '', 'x1'];

  it('survives every plain/marked transition with whitespace at the edges', () => {
    let checked = 0;
    for (const [markName, marks] of Object.entries(MARK_SETS)) {
      for (const middle of MIDDLES) {
        for (const before of NEIGHBOURS) {
          for (const after of NEIGHBOURS) {
            const nodes: unknown[] = [];
            if (before !== '') nodes.push(text(before));
            nodes.push(text(middle, marks));
            if (after !== '') nodes.push(text(after));
            const input = doc(para(...nodes));
            if (Either.isLeft(canonicalizeDocument(input))) continue;
            assertRoundTrip(input, `${before}|${markName}:${JSON.stringify(middle)}|${after}`);
            checked += 1;
          }
        }
      }
    }
    assert.ok(checked > 500, `expected a broad sweep, checked ${checked}`);
  });

  it('survives adjacent marked runs', () => {
    for (const [firstName, first] of Object.entries(MARK_SETS)) {
      for (const [secondName, second] of Object.entries(MARK_SETS)) {
        for (const middle of ['y', ' y ']) {
          const input = doc(para(text(middle, first), text('z', second)));
          if (Either.isLeft(canonicalizeDocument(input))) continue;
          assertRoundTrip(input, `${firstName}+${secondName} ${JSON.stringify(middle)}`);
        }
      }
    }
  });

  it('moves whitespace out of emphasis rather than losing it', () => {
    // Every character is kept; only the span of the mark narrows, which renders identically.
    const result = canonicalizeDocument(
      doc(para(text('x'), text(' y ', [{ type: 'bold' }]), text('z'))),
    );
    assert.ok(Either.isRight(result));
    const paragraphs = result.right as unknown as { content: { content: unknown }[] };
    assert.deepEqual(paragraphs.content[0]?.content, [
      { type: 'text', text: 'x ' },
      { type: 'text', marks: [{ type: 'bold' }], text: 'y' },
      { type: 'text', text: ' z' },
    ]);
  });

  it('keeps whitespace inside links and code spans, which have no flanking rule', () => {
    const linked = canonicalizeDocument(
      doc(para(text(' y ', [{ type: 'link', attrs: { href: 'https://e.com' } }]))),
    );
    assert.ok(Either.isRight(linked));
    const document = linked.right as unknown as { content: { content: { text: string }[] }[] };
    assert.equal(document.content[0]?.content[0]?.text, ' y ');
  });

  it('drops emphasis that covers only whitespace', () => {
    const result = canonicalizeDocument(
      doc(para(text('x'), text('   ', [{ type: 'bold' }]), text('z'))),
    );
    assert.ok(Either.isRight(result));
    const paragraphs = result.right as unknown as { content: { content: unknown }[] };
    assert.deepEqual(paragraphs.content[0]?.content, [{ type: 'text', text: 'x   z' }]);
  });
});

describe('known limit: emphasis edged with punctuation beside a word character', () => {
  /**
   * CommonMark's delimiter-flanking rule makes this inexpressible, not merely awkward to encode. An
   * opening run followed by punctuation only opens emphasis when it is itself preceded by whitespace
   * or punctuation, so `x**.y**x` and `x**y.**x` both parse as literal text. Escaping does not help
   * (a backslash is punctuation), numeric references do not help (`&` is punctuation), `_` and `~~`
   * share the rule, and HTML is not canonical here.
   *
   * Unlike boundary whitespace, the punctuation cannot be moved outside the mark: that would change
   * what is emphasized, which is a rendering change rather than a neutral canonicalization. It is
   * therefore a genuine best-effort export limit of the kind ADR 0005 describes, pinned here so it
   * stays visible.
   */
  it('cannot express emphasis starting with punctuation next to a word', () => {
    const input = doc(para(text('x'), text('.y', [{ type: 'bold' }]), text('x')));
    const original = canonical(input);
    const reimported = fromMarkdown(toMarkdown(original as never));
    assert.ok(Either.isRight(reimported));
    assert.notDeepEqual(reimported.right, original);
  });

  it('expresses the same content when a space separates the runs', () => {
    assertRoundTrip(
      doc(para(text('x '), text('.y', [{ type: 'bold' }]), text(' x'))),
      'separated by spaces',
    );
  });

  it('expresses the same content at the start and end of a paragraph', () => {
    assertRoundTrip(doc(para(text('.y', [{ type: 'bold' }]))), 'alone in a paragraph');
  });
});
