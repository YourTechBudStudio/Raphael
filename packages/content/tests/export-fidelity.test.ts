import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Schema } from '@tiptap/pm/model';
import { Either } from 'effect';

import { markdownSerializer, toMarkdown } from '../src/conversion/export.ts';
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

describe('the library-backed serializer keeps what the hand-written one protected', () => {
  /**
   * These are the cases that decided the configuration in the first place: a serializer that
   * collapses blank lines inside a fence, writes a fixed three-backtick fence, spells a code span
   * without its delimiters, or indents a list item under its own marker loses content rather than
   * spelling. They run against the installed library, which is the only thing that establishes
   * fidelity — reading the library's source establishes only which seams exist.
   */
  const cases: Record<string, unknown> = {
    'code block with a run of blank lines': doc({
      type: 'codeBlock',
      attrs: { language: null },
      content: [text('a\n\n\nb')],
    }),
    'mermaid source with arrows and a blank line': doc({
      type: 'codeBlock',
      attrs: { language: 'mermaid' },
      content: [text('graph TD;\n  A-->B;\n\n  B-->C;')],
    }),
    'code block that ends with a blank line': doc({
      type: 'codeBlock',
      attrs: { language: null },
      content: [text('a\n')],
    }),
    'code block inside a blockquote': doc({
      type: 'blockquote',
      content: [{ type: 'codeBlock', attrs: { language: null }, content: [text('a\n\nb')] }],
    }),
    'code block inside a list item': doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para(text('item')),
            { type: 'codeBlock', attrs: { language: null }, content: [text('a\n\nb')] },
          ],
        },
      ],
    }),
    'paragraph that looks like a heading': doc(para(text('# not a heading'))),
    'paragraph with four leading spaces': doc(para(text('    four spaces'))),
    // A literal space cannot reach a canonical href: `isAllowedHref` rejects it, so the encoded
    // form is the one a stored document can hold. The unbalanced paren is what exercises the
    // angle-bracket destination branch, since a bare destination ends at the first unbalanced `)`.
    'link whose destination holds a paren and an encoded space': doc(
      para(link('x', 'https://example.com/a(b%20c')),
    ),
    'bullet list three levels deep': doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para(text('one')),
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    para(text('two')),
                    {
                      type: 'bulletList',
                      content: [{ type: 'listItem', content: [para(text('three'))] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
    'ordered list spanning a digit width': doc({
      type: 'orderedList',
      attrs: { start: 9 },
      content: [
        { type: 'listItem', content: [para(text('nine'))] },
        { type: 'listItem', content: [para(text('ten'))] },
        { type: 'listItem', content: [para(text('eleven'))] },
      ],
    }),
    'ordered list crossing a digit width with a nested list': doc({
      type: 'orderedList',
      attrs: { start: 9 },
      content: [
        { type: 'listItem', content: [para(text('nine'))] },
        {
          type: 'listItem',
          content: [
            para(text('ten')),
            { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('under'))] }] },
          ],
        },
      ],
    }),
    'list item holding several blocks': doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [para(text('first paragraph')), para(text('second paragraph'))],
        },
        { type: 'listItem', content: [para(text('other item'))] },
      ],
    }),
    'code span beside a link inside a list item': doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [para(code('x`y'), text(' then '), link('l', 'https://e.com/a(b'))],
        },
      ],
    }),
  };

  for (const [label, input] of Object.entries(cases)) {
    it(`survives: ${label}`, () => {
      assertRoundTrip(input, label);
    });
  }

  it('writes code-span delimiters, which the text serializer never sees', () => {
    // `renderInline` writes a text node whose innermost mark declares `escape: false` itself. A
    // configuration that put the delimiters in `nodes.text` emits content with no backticks at all,
    // and every code span silently becomes ordinary text.
    const markdown = toMarkdown(canonical(doc(para(code('const x = 1;')))) as never);
    assert.equal(markdown, '`const x = 1;`');
  });

  it('sizes a code-span fence above the longest run it contains', () => {
    assert.equal(toMarkdown(canonical(doc(para(code('a``b')))) as never), '```a``b```');
  });

  it('keeps authored code bytes out of the wrapper indentation inside a list', () => {
    // The wrapper's indentation is Markdown spelling; the source between the fences is authored
    // data. A blank line in the source must stay blank, not acquire the list delimiter as content.
    const document = canonical({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('item')),
                { type: 'codeBlock', attrs: { language: null }, content: [text('a\n\nb')] },
              ],
            },
          ],
        },
      ],
    });
    const markdown = toMarkdown(document as never);
    const reimported = fromMarkdown(markdown);
    assert.ok(Either.isRight(reimported));
    const source = JSON.stringify(reimported.right);
    assert.ok(source.includes('a\\n\\nb'), markdown);
  });

  it('keeps lists compact', () => {
    // A loose list would put a blank line between every item of every note. The canonical schema has
    // no per-list `tight` attribute, so the serializer option is what carries the convention.
    const markdown = toMarkdown(
      canonical({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [para(text('one'))] },
              { type: 'listItem', content: [para(text('two'))] },
            ],
          },
        ],
      }) as never,
    );
    assert.equal(markdown, '- one\n- two');
  });

  it('refuses a document holding a node outside the canonical schema', () => {
    // This is rejected by `Node.fromJSON` against `contentSchema`, before the serializer is
    // reached. It says the pipeline refuses unknown content; it says nothing about `strict`.
    assert.throws(() => toMarkdown({ type: 'doc', content: [{ type: 'image' }] } as never), {
      message: /Unknown node type: image/u,
    });
  });

  it('raises rather than dropping a node the serializer has no configuration for', () => {
    // `strict: true`, asserted against the configured serializer itself. A future canonical node
    // added without an exporter must fail loudly; silently vanishing content is the failure mode
    // this replaces. `toMarkdown` cannot show this, because its input is deserialized against
    // `contentSchema` first and never reaches the serializer.
    const foreign = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'text*' },
        image: { group: 'block' },
        text: {},
      },
      marks: { highlight: {} },
    });

    const withUnknownNode = foreign.node('doc', null, [foreign.node('image')]);
    assert.throws(() => markdownSerializer.serialize(withUnknownNode), {
      message: /Token type `image` not supported by Markdown renderer/u,
    });

    const withUnknownMark = foreign.node('doc', null, [
      foreign.node('paragraph', null, [foreign.text('x', [foreign.mark('highlight')])]),
    ]);
    assert.throws(() => markdownSerializer.serialize(withUnknownMark), {
      message: /Mark type `highlight` not supported by Markdown renderer/u,
    });
  });
});

describe('boundary whitespace is encoded at line edges, not at every fragment', () => {
  /**
   * `encodeBoundaryWhitespace` defends a line edge. The hand-written exporter applied it once per
   * assembled block line; serializing a document one text node at a time would widen it to every
   * fragment, so an ordinary sentence containing a bold word or a link came back with `&#32;` in
   * place of its spaces — in the default format of the API and the CLI.
   *
   * Both halves are asserted here: the spelling stays readable in the middle of a line, and the
   * edges are still defended. Fidelity is asserted independently by the round-trip cases above,
   * which cover whitespace at every edge in every block context.
   */
  const markdown = (input: unknown): string => toMarkdown(canonical(input) as never);

  it('leaves whitespace in the middle of a line alone', () => {
    assert.equal(
      markdown(doc(para(text('Some '), text('bold', [{ type: 'bold' }]), text(' text.')))),
      'Some **bold** text.',
    );
    assert.equal(
      markdown(doc(para(text('see '), link('the docs', 'https://example.com'), text(' now')))),
      'see [the docs](https://example.com) now',
    );
  });

  it('still encodes whitespace that opens or closes a line', () => {
    assert.equal(markdown(doc(para(text('    four spaces')))), '&#32;&#32;&#32;&#32;four spaces');
    assert.equal(markdown(doc(para(text('trailing  ')))), 'trailing&#32;&#32;');
  });

  it('still encodes whitespace at the edges a hard break creates', () => {
    assert.equal(
      markdown(doc(para(text('one  '), { type: 'hardBreak' }, text('  two')))),
      'one&#32;&#32;\\\n&#32;&#32;two',
    );
  });

  /**
   * Inline text cannot hold a newline, which is what makes the line edges of a block identifiable.
   * It does not by itself say how a fragment behaves beside a generated delimiter, so the
   * interactions are exercised rather than reasoned about: a link label brings its own whitespace
   * inside brackets, an emphasis delimiter sits between two fragments, and a hard break turns a
   * mark boundary into a line boundary.
   */
  it('keeps a whitespace-bearing link label intact wherever it sits', () => {
    const label = (href: string): unknown => text(' y ', [{ type: 'link', attrs: { href } }]);
    // Mid-line: the label's spaces are inside the brackets, so nothing strips them and nothing
    // needs encoding.
    assert.equal(
      markdown(doc(para(text('x'), label('https://e.com'), text('z')))),
      'x[ y ](https://e.com)z',
    );
    assertRoundTrip(doc(para(text('x'), label('https://e.com'), text('z'))), 'label mid-line');
    // At both line edges, and with a hard break making new ones.
    assertRoundTrip(doc(para(label('https://e.com'))), 'label alone');
    assertRoundTrip(
      doc(para(label('https://e.com'), { type: 'hardBreak' }, label('https://e.com/2'))),
      'labels either side of a hard break',
    );
  });

  it('encodes a fragment beside a mark only where the fragment meets a line edge', () => {
    const bold = (value: string): unknown => text(value, [{ type: 'bold' }]);
    // Between two marks, mid-line: readable.
    assert.equal(markdown(doc(para(bold('a'), text('  '), bold('b')))), '**a**  **b**');
    // The same fragment at the end of the line: encoded, because Markdown would strip it and two
    // trailing spaces would come back as a hard break.
    assert.equal(markdown(doc(para(bold('a'), text('  ')))), '**a**&#32;&#32;');
    // And where a hard break makes the mark boundary a line boundary.
    assert.equal(
      markdown(doc(para(bold('a'), text('  '), { type: 'hardBreak' }, text('  '), bold('b')))),
      '**a**&#32;&#32;\\\n&#32;&#32;**b**',
    );
    for (const [label, input] of [
      ['between marks', doc(para(bold('a'), text('  '), bold('b')))],
      ['after a mark at the line end', doc(para(bold('a'), text('  ')))],
      ['before a mark at the line start', doc(para(text('  '), bold('b')))],
      [
        'either side of a hard break',
        doc(para(bold('a'), text('  '), { type: 'hardBreak' }, text('  '), bold('b'))),
      ],
    ] as const) {
      assertRoundTrip(input, label);
    }
  });
});

describe('every hard-break placement survives export and re-import', () => {
  /**
   * The corpus above exercised only a break between two runs of paragraph text. The placements it
   * missed were the ones Markdown cannot encode, and they did not fail loudly: a break ending a
   * paragraph came back as a literal `\`, and a break inside a heading came back as a heading *and a
   * separate paragraph*. Canonicalization now normalizes those placements before storage, so the
   * document that is stored is one Markdown can carry.
   *
   * These start from the pre-normalization document, so they assert the property that matters end to
   * end: whatever a client submits, what is stored and what is read back are the same document.
   * `src/schema/hard-breaks.test.ts` asserts the other half — which document is stored.
   */
  const br = (marks?: unknown[]): unknown =>
    marks === undefined ? { type: 'hardBreak' } : { type: 'hardBreak', marks };
  const head = (...content: unknown[]): unknown => ({
    type: 'heading',
    attrs: { level: 2 },
    content,
  });
  const item = (...content: unknown[]): unknown => ({
    type: 'bulletList',
    content: [{ type: 'listItem', content }],
  });
  const LINK = [{ type: 'link', attrs: { href: 'https://example.com' } }];
  const BOLD = [{ type: 'bold' }];

  const cases: Record<string, unknown> = {
    'paragraph ending in a break': doc(para(text('a'), br())),
    'paragraph ending in a run of breaks': doc(para(text('a'), br(), br(), br())),
    'paragraph of only a break': doc(para(br())),
    'paragraph opening with a break': doc(para(br(), text('a'))),
    'break between paragraph text': doc(para(text('a'), br(), text('b'))),
    'consecutive breaks between paragraph text': doc(para(text('a'), br(), br(), text('b'))),
    'heading with an interior break': doc(head(text('a'), br(), text('b'))),
    'heading with consecutive interior breaks': doc(head(text('a'), br(), br(), text('b'))),
    'heading opening with a break': doc(head(br(), text('a'))),
    'heading ending in a break': doc(head(text('a'), br())),
    'heading of only a break': doc(head(br())),
    'heading break inside a link': doc(head(text('a', LINK), br(LINK), text('b', LINK))),
    'heading break inside bold': doc(head(text('a', BOLD), br(BOLD), text('b', BOLD))),
    'list item with an interior break': doc(item(para(text('a'), br(), text('b')))),
    'list item ending in a break': doc(item(para(text('a'), br()))),
    'break carrying a mark between unmarked text': doc(para(text('a'), br(BOLD), text('b'))),
    'link spanning a paragraph break': doc(para(text('a', LINK), br(LINK), text('b', LINK))),
    'bold spanning a paragraph break': doc(para(text('a', BOLD), br(BOLD), text('b', BOLD))),
    'marked break followed by plain text': doc(para(text('a', BOLD), br(BOLD), text('c'))),
    'consecutive marked breaks': doc(para(text('a', BOLD), br(BOLD), br(BOLD), text('b', BOLD))),
    'marked break in a list item': doc(item(para(text('a', LINK), br(LINK), text('b', LINK)))),
    'break beside a code span': doc(para(code('x'), br(), code('y'))),
    'break beside a link': doc(para(link('a', 'https://example.com'), br(), text('b'))),
    'break in a blockquote': doc({
      type: 'blockquote',
      content: [para(text('a'), br(), text('b')), para(text('c'), br())],
    }),
  };

  for (const [label, input] of Object.entries(cases)) {
    it(`survives: ${label}`, () => {
      assertRoundTrip(input, label);
    });
  }

  it('keeps a break that carries meaning and drops only the one that cannot', () => {
    // The distinction in one assertion: the interior break is still a break in the exported
    // Markdown, and the terminal one has left no trace behind it.
    assert.equal(
      toMarkdown(canonical(doc(para(text('a'), br(), text('b'), br()))) as never),
      'a\\\nb',
    );
  });
});
