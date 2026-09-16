import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Either } from 'effect';

import { canonicalizeDocument } from './canonicalize.ts';

/**
 * What canonicalization stores for each hard-break placement.
 *
 * The companion assertions in `tests/export-fidelity.test.ts` check the other half — that every
 * stored result survives export and re-import. Both halves are needed: a normalization that made
 * documents expressible while changing what a reader sees would pass the round trip and still be
 * wrong, and a round trip alone would not say which document was stored.
 */

const text = (value: string, marks?: unknown[]): unknown =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const br = (marks?: unknown[]): unknown =>
  marks === undefined ? { type: 'hardBreak' } : { type: 'hardBreak', marks };
const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content });
const heading = (...content: unknown[]): unknown => ({
  type: 'heading',
  attrs: { level: 2 },
  content,
});
const doc = (...content: unknown[]): unknown => ({ type: 'doc', content });

const stored = (input: unknown): { content: { content?: unknown[] }[] } => {
  const result = canonicalizeDocument(input);
  assert.ok(Either.isRight(result), `not canonical: ${JSON.stringify(result)}`);
  return result.right as unknown as { content: { content?: unknown[] }[] };
};

const inlineOf = (input: unknown): unknown => stored(input).content[0]?.content;

const LINK = [{ type: 'link', attrs: { href: 'https://example.com' } }];
const BOLD = [{ type: 'bold' }];

describe('hard breaks that end a block are dropped', () => {
  /**
   * A break in that position renders as nothing, and Markdown has no encoding for it: `a\` at the
   * end of a paragraph is a literal backslash, so exporting and re-importing used to return the
   * break as text. Dropping it before storage is what makes storage and export agree.
   */

  it('drops one at the end of a paragraph', () => {
    assert.deepEqual(inlineOf(doc(para(text('a'), br()))), [{ type: 'text', text: 'a' }]);
  });

  it('drops a run of them at the end of a paragraph', () => {
    assert.deepEqual(inlineOf(doc(para(text('a'), br(), br(), br()))), [
      { type: 'text', text: 'a' },
    ]);
  });

  it('drops one at the end of a heading', () => {
    // Trailing breaks are removed before the heading rule runs, so this loses the break rather than
    // gaining a trailing space.
    assert.deepEqual(inlineOf(doc(heading(text('a'), br()))), [{ type: 'text', text: 'a' }]);
  });

  it('leaves an empty paragraph when the break was the only content', () => {
    assert.deepEqual(stored(doc(para(br()))), { type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('drops one at the end of a paragraph inside a list item', () => {
    const document = stored(
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para(text('a'), br())] }],
      }),
    );
    assert.deepEqual(document.content[0], {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
        },
      ],
    });
  });
});

describe('hard breaks inside a heading become spaces', () => {
  /**
   * An ATX heading is a single line, so a break inside one has no encoding at all — `<br>` is not an
   * alternative, because the parser runs with `html: false` and would return it as literal text.
   * Exporting used to turn the heading into a heading *and a separate paragraph*: a change of block
   * structure. A space keeps the reading order on one line, which is what a heading can express.
   */

  it('replaces an interior break with a space', () => {
    // Adjacent unmarked text merges during canonical serialization, so the result is one node.
    assert.deepEqual(inlineOf(doc(heading(text('a'), br(), text('b')))), [
      { type: 'text', text: 'a b' },
    ]);
  });

  it('replaces a run of interior breaks', () => {
    assert.deepEqual(inlineOf(doc(heading(text('a'), br(), br(), text('b')))), [
      { type: 'text', text: 'a  b' },
    ]);
  });

  it('replaces a leading break', () => {
    assert.deepEqual(inlineOf(doc(heading(br(), text('a')))), [{ type: 'text', text: ' a' }]);
  });

  it('keeps a link spanning the break intact', () => {
    // The replacement carries the break's own marks, so the link covers one continuous label rather
    // than splitting into two links pointing at the same destination.
    assert.deepEqual(inlineOf(doc(heading(text('a', LINK), br(LINK), text('b', LINK)))), [
      { type: 'text', marks: LINK, text: 'a b' },
    ]);
  });

  it('lets the emphasis rule narrow a delimiter mark around the space', () => {
    // The replacement carries the bold mark, and then the existing mark-boundary rule applies:
    // emphasis covering only whitespace is dropped, because CommonMark cannot express it. Every
    // character survives and the rendered result is identical; only the span of the mark changes.
    assert.deepEqual(inlineOf(doc(heading(text('a', BOLD), br(BOLD), text('b', BOLD)))), [
      { type: 'text', marks: BOLD, text: 'a' },
      { type: 'text', text: ' ' },
      { type: 'text', marks: BOLD, text: 'b' },
    ]);
  });
});

describe('a break that stays a break carries no marks', () => {
  /**
   * A mark on the break itself has no Markdown encoding in any position. An isolated bold break
   * between two unmarked runs exports as a bare `a\\` — the mark leaves no trace to import back —
   * and a break whose mark does not continue onto the next node is written outside that mark's
   * delimiters. `prosemirror-markdown` strips such marks on its own side for the same reason.
   *
   * Dropping the mark before storage loses nothing a reader sees: a line break renders as a line
   * break whether or not it is bold. Keeping it would lose it on the next read instead, silently.
   */

  it('drops a mark carried by a break between unmarked text', () => {
    assert.deepEqual(inlineOf(doc(para(text('a'), br(BOLD), text('b')))), [
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('drops a mark that spans the break, leaving the text marks untouched', () => {
    assert.deepEqual(inlineOf(doc(para(text('a', LINK), br(LINK), text('b', LINK)))), [
      { type: 'text', marks: LINK, text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', marks: LINK, text: 'b' },
    ]);
  });

  it('drops marks from consecutive breaks', () => {
    assert.deepEqual(inlineOf(doc(para(text('a', BOLD), br(BOLD), br(BOLD), text('b', BOLD)))), [
      { type: 'text', marks: BOLD, text: 'a' },
      { type: 'hardBreak' },
      { type: 'hardBreak' },
      { type: 'text', marks: BOLD, text: 'b' },
    ]);
  });

  it('drops a mark from a break inside a list item', () => {
    const document = stored(
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(text('a', LINK), br(LINK), text('b', LINK))] },
        ],
      }),
    );
    const item = document.content[0] as { content: { content: { content: unknown[] }[] }[] };
    assert.deepEqual(item.content[0]?.content[0]?.content, [
      { type: 'text', marks: LINK, text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', marks: LINK, text: 'b' },
    ]);
  });

  it('keeps the marks on a heading break, which becomes text rather than staying a break', () => {
    // The two rules do not conflict: a space can carry a mark expressibly, a break cannot.
    assert.deepEqual(inlineOf(doc(heading(text('a', LINK), br(LINK), text('b', LINK)))), [
      { type: 'text', marks: LINK, text: 'a b' },
    ]);
  });
});

describe('hard breaks that Markdown can express are left alone', () => {
  it('keeps an interior break in a paragraph', () => {
    assert.deepEqual(inlineOf(doc(para(text('a'), br(), text('b')))), [
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('keeps consecutive interior breaks in a paragraph', () => {
    assert.deepEqual(inlineOf(doc(para(text('a'), br(), br(), text('b')))), [
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('keeps a leading break in a paragraph', () => {
    assert.deepEqual(inlineOf(doc(para(br(), text('a')))), [
      { type: 'hardBreak' },
      { type: 'text', text: 'a' },
    ]);
  });

  it('keeps an interior break inside a list item', () => {
    const document = stored(
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para(text('a'), br(), text('b'))] }],
      }),
    );
    const item = document.content[0] as { content: { content: { content: unknown[] }[] }[] };
    assert.deepEqual(item.content[0]?.content[0]?.content, [
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
  });
});

describe('normalization is idempotent and judged after validation', () => {
  it('returns the same document when canonicalized twice', () => {
    const once = stored(doc(heading(text('a'), br(), text('b')), para(text('c'), br())));
    assert.deepEqual(stored(once), once);
  });

  it('still refuses an unsupported mark on a break rather than normalizing it away', () => {
    // Validation judges what was submitted. If placement ran first, a heading break carrying an
    // unsupported mark would become a space and the submission would be silently accepted.
    const result = canonicalizeDocument(
      doc(heading(text('a'), br([{ type: 'highlight' }]), text('b'))),
    );
    assert.ok(Either.isLeft(result));
    assert.equal(result.left.reason, 'unsupported_mark');
  });
});
