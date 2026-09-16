import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Node as ContentNode } from '@tiptap/pm/model';
import { MarkdownSerializer } from 'prosemirror-markdown';
import type { MarkdownSerializerState } from 'prosemirror-markdown';

import type { CanonicalDocument } from '../index.ts';
import { contentSchema } from '../schema/canonicalize.ts';
import {
  codeSpanDelimiters,
  encodeBoundaryWhitespace,
  escapeText,
  linkDestination,
} from './escape.ts';

/**
 * Markdown export, configured over `prosemirror-markdown`.
 *
 * Read the split honestly: the library owns traversal and the structural machinery that a
 * hand-written exporter keeps getting wrong — per-line writing that never collapses a run inside a
 * fence, block spacing, list indentation, blockquote prefixing — and `strict: true` makes a future
 * canonical node without a serializer raise instead of silently vanishing.
 *
 * The policy is still ours, and it is in two places, not one. `escape.ts` owns what happens to a
 * character: escaping, boundary whitespace, code-span delimiters and padding, and link
 * destinations. This file owns what happens to a block: fence sizing, the ordered-list marker, the
 * hard-break spelling, and the node and mark serializers themselves. This file is a configuration,
 * but it is load-bearing.
 *
 * Export is best effort, as ADR 0005 describes, and that is a real limit rather than a caveat.
 * Markdown syntax spelling is not promised to round-trip byte for byte. Supported text and code
 * content do survive: the corpus in `tests/export-fidelity.test.ts` exports and re-imports canonical
 * documents across the supported vocabulary, every ASCII punctuation run, whitespace at every edge
 * in every block context, and the plain/marked transitions an editor produces. Known exceptions are
 * pinned there too — emphasis whose content is edged with punctuation beside a word character has no
 * CommonMark encoding — so this is a tested guarantee over a tested corpus, not a universal claim
 * that any canonical body survives unchanged.
 */

/** A fence must be at least three delimiters and always longer than the longest run it contains. */
const fenceFor = (content: string): string => {
  let longest = 0;
  for (const run of content.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
};

/**
 * The text a code mark's delimiters are computed from.
 *
 * `renderInline` calls the mark's `open` with the text node's own index and its `close` with
 * `index + 1`, so both callbacks read the same node. The bounds check is not defensive decoration:
 * `close` is called with an index one past the end when the code span is the last child.
 */
const codeTextAt = (parent: ContentNode, index: number): string => {
  if (index < 0 || index >= parent.childCount) return '';
  const child = parent.child(index);
  return child.isText ? (child.text ?? '') : '';
};

const attrNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Exported for tests only, and deliberately absent from `@raphael/content/conversion`.
 *
 * `strict: true` is a property of *this* configuration, and `toMarkdown` cannot demonstrate it: its
 * input is deserialized against `contentSchema` first, so a node with no serializer is rejected by
 * `Node.fromJSON` before the serializer runs. Reaching the configured serializer directly is what
 * makes the strictness assertion about strictness.
 */
export const markdownSerializer = new MarkdownSerializer(
  {
    /**
     * Our escaping, never the library's: `state.text(value, false)` writes the string as given.
     *
     * The two policies have deliberately different scopes, which is how they were written.
     *
     * `escapeText` runs on every text node, as it always has. It escapes more than is strictly
     * necessary — a mid-line `#` becomes `\#` — and that is an accepted spelling cost, because
     * deciding otherwise would mean predicting the emitted line from inside a text callback.
     *
     * `encodeBoundaryWhitespace` defends a *line edge*: whitespace Markdown would strip, four
     * leading spaces that would become an indented code block, two trailing spaces that would
     * become a hard break. None of that applies in the middle of a line, and the hand-written
     * exporter this replaced applied it once per assembled block line for exactly that reason.
     * Serializing a document one text node at a time would widen it to every fragment, so that a
     * space beside a bold run came back as `&#32;` — a change to what a person reads, in the
     * default format of the API and the CLI. The line edges are therefore identified rather than
     * assumed. Within one inline sequence they are the first child, which opens the block's line,
     * and either side of a `hardBreak`, which is where a line ends and the next begins; inline text
     * cannot contain a newline of its own, because validation rejects one. A text node is the only
     * thing that can carry whitespace to an edge, so no other node needs to take part.
     *
     * Code-marked text never reaches here: `renderInline` writes a text node whose innermost mark
     * declares `escape: false` from that mark's `open`/`close` and never calls this serializer.
     */
    text: (
      state: MarkdownSerializerState,
      node: ContentNode,
      parent: ContentNode,
      index: number,
    ) => {
      const isHardBreak = (at: number): boolean =>
        at >= 0 && at < parent.childCount && parent.child(at).type.name === 'hardBreak';
      const edges = {
        atLineStart: index === 0 || isHardBreak(index - 1),
        atLineEnd: index === parent.childCount - 1 || isHardBreak(index + 1),
      };
      state.text(encodeBoundaryWhitespace(escapeText(node.text ?? ''), edges), false);
    },
    paragraph: (state: MarkdownSerializerState, node: ContentNode) => {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading: (state: MarkdownSerializerState, node: ContentNode) => {
      state.write(`${'#'.repeat(attrNumber(node.attrs['level'], 1))} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    horizontalRule: (state: MarkdownSerializerState, node: ContentNode) => {
      state.write('---');
      state.closeBlock(node);
    },
    blockquote: (state: MarkdownSerializerState, node: ContentNode) => {
      state.wrapBlock('> ', null, node, () => state.renderContent(node));
    },
    bulletList: (state: MarkdownSerializerState, node: ContentNode) => {
      state.renderList(node, '  ', () => '- ');
    },
    /**
     * Markers are right-aligned within the list so that every item's content starts at the same
     * column, which is what keeps a nested list nested when the numbering crosses a digit width
     * (`9.` to `10.`). The continuation indent is the marker width, so a wrapped line or a child
     * block lands under the content rather than under the marker.
     */
    orderedList: (state: MarkdownSerializerState, node: ContentNode) => {
      const start = attrNumber(node.attrs['start'], 1);
      const width = String(start + node.childCount - 1).length;
      state.renderList(node, ' '.repeat(width + 2), (index: number) => {
        const marker = String(start + index);
        return `${' '.repeat(width - marker.length)}${marker}. `;
      });
    },
    listItem: (state: MarkdownSerializerState, node: ContentNode) => {
      state.renderContent(node);
    },
    /**
     * `state.text(source, false)` writes the source line by line through `write()`, which prefixes
     * the active block delimiter and never collapses a run of blank lines. That is what makes an
     * authored blank line inside a fence — or inside Mermaid source — survive a round trip, and it
     * is the defect the previous hand-written exporter carried.
     */
    codeBlock: (state: MarkdownSerializerState, node: ContentNode) => {
      const source = node.textContent;
      const fence = fenceFor(source);
      const language = node.attrs['language'];
      state.write(`${fence}${typeof language === 'string' ? language : ''}\n`);
      state.text(source, false);
      state.write('\n');
      state.write(fence);
      state.closeBlock(node);
    },
    /**
     * A backslash break rather than the library's two trailing spaces: it is visible in the source
     * and it survives `encodeBoundaryWhitespace`, which exists precisely to stop trailing spaces
     * being read back as a break.
     */
    hardBreak: (state: MarkdownSerializerState) => {
      state.write('\\\n');
    },
  },
  {
    /**
     * `expelEnclosingWhitespace` is a safety net, not the authority. `normalizeMarkBoundaries` moves
     * whitespace out of emphasis during canonicalization, so a stored document already has the
     * property and this option is a no-op on every document `toMarkdown` is meant to receive. It is
     * not a substitute for validation: `toMarkdown` consumes canonical documents.
     */
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    /**
     * `escape: false` tells `renderInline` to write this text node itself, from these two
     * callbacks. The delimiters therefore cannot live in `nodes.text` — a configuration that put
     * them there would emit code-span content with no backticks at all. This is also where the
     * library's own default puts them.
     *
     * The mark is always innermost on canonical content: `@tiptap/extension-code` declares
     * `excludes: '_'`, and `node.check()` during canonicalization rebuilds the mark set and throws
     * when the result differs, so a canonical code-marked text node carries that mark alone.
     */
    code: {
      open: (_state: MarkdownSerializerState, _mark, parent: ContentNode, index: number) =>
        codeSpanDelimiters(codeTextAt(parent, index)).open,
      close: (_state: MarkdownSerializerState, _mark, parent: ContentNode, index: number) =>
        codeSpanDelimiters(codeTextAt(parent, index - 1)).close,
      escape: false,
    },
    link: {
      open: '[',
      close: (_state: MarkdownSerializerState, mark) =>
        `](${linkDestination(String(mark.attrs['href'] ?? ''))})`,
      mixable: false,
    },
  },
  { hardBreakNodeName: 'hardBreak', strict: true },
);

/**
 * Lists stay compact. The canonical schema has no `tight` attribute to carry the choice per list,
 * and a loose list would put a blank line between every item of every note. The option belongs to
 * `serialize`, not to the constructor, which is why it is passed here.
 */
export const toMarkdown = (document: CanonicalDocument): string =>
  markdownSerializer.serialize(ProseMirrorNode.fromJSON(contentSchema, document), {
    tightLists: true,
  });
