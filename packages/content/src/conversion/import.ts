import { Either } from 'effect';
import type { Token } from 'markdown-it';

import { DEGRADED_CONSTRUCTS, type DegradedConstruct } from '../degraded.ts';
import { contentFailure, type ContentFailure } from '../failures.ts';
import { SUPPORTED_HEADING_LEVELS } from '../headings.ts';
import type { CanonicalDocument } from '../index.ts';
import { canonicalizeDocument } from '../schema/canonicalize.ts';
import { CODE_LANGUAGE, isAllowedHref } from '../validation/index.ts';
import { linkDestination } from './escape.ts';
import { containsRawHtml } from './html.ts';
import { tokenizeMarkdown } from './parser.ts';

/**
 * Markdown import.
 *
 * Every token the pinned configuration can emit is classified deliberately as supported, preserved
 * as source, or rejected. There is no default branch that quietly drops a token, because structural
 * validity does not prove preservation: a dropped table yields an empty document, which is
 * flawlessly valid and completely wrong.
 *
 * Preservation uses the parser's own source spans (`token.map`), never a second Markdown grammar.
 * The promise is the source the parser captured, not byte-for-byte recovery of arbitrary Markdown.
 *
 * Every construct kept as source rather than as itself is recorded as it is met (`Degraded`), so a
 * client can tell the author what changed without a second pass over the document.
 */

/** What one import degraded, collected while converting. */
type Degraded = Set<DegradedConstruct>;

/** A task list item starts with a checkbox: `[ ]`, `[x]` or `[X]`, then space or the end. */
const TASK_MARKER = /^\[[ xX]\](?:[ \t]|$)/u;

interface MutableNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: MutableNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Block tokens whose source we keep verbatim inside a language-less code block. */
const PRESERVED_BLOCKS = new Set(['table_open', 'html_block']);

/** Tokens that carry no content and are intentionally ignored (they close preserved regions). */
const IGNORED = new Set(['table_close']);

/**
 * Source lines, split once per conversion.
 *
 * Splitting inside the lookup made conversion cost proportional to preserved blocks times source
 * lines: 2,000 preserved headings took 203ms against 13ms for the same document with supported
 * headings. Conversion is synchronous and will run on the server's only thread, so that cost is not
 * a micro-optimization.
 */
const sourceOf = (lines: readonly string[], token: Token): string => {
  if (token.map === null) return token.content.replace(/\s+$/u, '');
  const [start, end] = token.map;
  return lines.slice(start, end).join('\n').replace(/\s+$/u, '');
};

const preservedBlock = (text: string): MutableNode => ({
  type: 'codeBlock',
  attrs: { language: null },
  content: text.length > 0 ? [{ type: 'text', text }] : [],
});

/**
 * Builds a text node, keeping at most one mark of each type. Markdown can nest the same emphasis
 * repeatedly (`***...***` or a long delimiter run), and a mark applies once however many times it
 * was opened; emitting it twice would produce a document the schema rejects.
 */
const textNode = (
  text: string,
  marks: readonly { type: string; attrs?: Record<string, unknown> }[],
): MutableNode => {
  if (marks.length === 0) return { type: 'text', text };
  const unique: { type: string; attrs?: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const mark of marks) {
    if (seen.has(mark.type)) continue;
    seen.add(mark.type);
    unique.push({ ...mark });
  }
  return { type: 'text', text, marks: unique };
};

const REJECTED_LINK = '__rejected_link';

/** A footnote marker, `[^1]`, and the same not preceded by a backslash. */
const FOOTNOTE = /\[\^[^\]\s]+\]/u;
const UNESCAPED_FOOTNOTE = /(?<!\\)\[\^[^\]\s]+\]/u;

/**
 * Inline conversion. Marks are tracked on an explicit stack rather than by recursion, and a link
 * whose destination fails policy degrades to its literal Markdown source instead of becoming a
 * clickable mark or rejecting the whole import.
 */
const convertInline = (token: Token, degraded: Degraded): MutableNode[] => {
  const out: MutableNode[] = [];
  // Plain text runs, code spans excluded, for the raw HTML check after the loop.
  let plain = '';
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  // How many nodes had been emitted when each open allowed link opened, to tell whether it held any.
  // Kept beside the marks rather than on them, because marks are copied into the document.
  const linkStarts: number[] = [];
  const push = (
    text: string,
    withMarks: readonly { type: string; attrs?: Record<string, unknown> }[] = marks,
  ): void => {
    if (text.length > 0) out.push(textNode(text, withMarks));
  };

  for (const child of token.children ?? []) {
    if (child.type !== 'text' && child.type !== 'code_inline') plain += '\n';
    switch (child.type) {
      case 'text':
        plain += child.content;
        push(child.content);
        break;
      case 'code_inline':
        plain += '\n';
        push(child.content, [...marks, { type: 'code' }]);
        break;
      case 'strong_open':
        marks.push({ type: 'bold' });
        break;
      case 'em_open':
        marks.push({ type: 'italic' });
        break;
      case 's_open':
        marks.push({ type: 'strike' });
        break;
      case 'strong_close':
      case 'em_close':
      case 's_close':
        marks.pop();
        break;
      case 'link_open': {
        const href = child.attrGet('href');
        if (isAllowedHref(href)) {
          // The link mark holds a destination only, so a title the author wrote is not stored.
          if ((child.attrGet('title') ?? '') !== '') degraded.add('link_title');
          marks.push({ type: 'link', attrs: { href } });
          linkStarts.push(out.length);
          break;
        }
        // Reported when met, not when its text is: a link with no label has none.
        degraded.add('disallowed_link');
        marks.push({ type: REJECTED_LINK, attrs: { href: href ?? '', emittedAt: out.length } });
        break;
      }
      case 'link_close': {
        const closed = marks.pop();
        // A refused link with no label left no text to carry its source, so it is kept here.
        if (closed?.type === REJECTED_LINK && closed.attrs?.['emittedAt'] === out.length) {
          push(`[](${String(closed.attrs['href'] ?? '')})`);
        }
        // An allowed link with no label has no text for its mark, so it is not stored at all.
        if (closed?.type === 'link' && linkStarts.pop() === out.length) degraded.add('empty_link');
        break;
      }
      case 'softbreak':
        push(' ');
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;
      // Images are not a supported node; the inline source is preserved as literal text so the
      // surrounding sentence keeps its meaning. A code block cannot stand in for an inline element.
      // Images are not a supported node. Every attribute the parser recovered is written back, so
      // a title is not quietly dropped; reference-style syntax is normalized by the parser before we
      // see it and is recorded as known loss rather than reconstructed.
      case 'image': {
        degraded.add('image');
        const source = String(child.attrGet('src') ?? '');
        const title = String(child.attrGet('title') ?? '');
        const destination = linkDestination(source);
        push(
          title === ''
            ? `![${child.content}](${destination})`
            : `![${child.content}](${destination} "${title.replaceAll('"', '\\"')}")`,
        );
        break;
      }
      default:
        push(child.content);
        break;
    }
  }

  if (containsRawHtml(plain, token.content)) degraded.add('raw_html');
  // A GFM footnote reference or definition, `[^1]`, as text outside code and written unescaped.
  if (FOOTNOTE.test(plain) && UNESCAPED_FOOTNOTE.test(token.content)) degraded.add('footnote');

  return out.map((node) => {
    if (node.type !== 'text' || node.marks === undefined) return node;
    const rejected = node.marks.find((mark) => mark.type === REJECTED_LINK);
    if (rejected === undefined) return node;
    const kept = node.marks.filter((mark) => mark.type !== REJECTED_LINK);
    return textNode(`[${node.text ?? ''}](${String(rejected.attrs?.['href'] ?? '')})`, kept);
  });
};

const HEADING_LEVELS: ReadonlySet<number> = new Set(SUPPORTED_HEADING_LEVELS);

const convertTokens = (
  tokens: readonly Token[],
  source: string,
  degraded: Degraded,
): MutableNode => {
  const lines = source.split('\n');
  const root: MutableNode = { type: 'doc', content: [] };
  const stack: MutableNode[] = [root];
  const top = (): MutableNode => stack[stack.length - 1] ?? root;
  const add = (node: MutableNode): void => {
    (top().content ??= []).push(node);
  };
  let skipUntil: string | null = null;
  // Set by a list item and cleared by its first inline run, which is where a checkbox would be.
  let itemStart = false;

  for (const token of tokens) {
    if (skipUntil !== null) {
      if (token.type === skipUntil) skipUntil = null;
      continue;
    }
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1));
        if (!HEADING_LEVELS.has(level)) {
          degraded.add('deep_heading');
          add(preservedBlock(sourceOf(lines, token))); // h4-h6 keep their source
          skipUntil = 'heading_close';
          break;
        }
        const node: MutableNode = { type: 'heading', attrs: { level }, content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'paragraph_open': {
        const node: MutableNode = { type: 'paragraph', content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'blockquote_open': {
        const node: MutableNode = { type: 'blockquote', content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'bullet_list_open': {
        const node: MutableNode = { type: 'bulletList', content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'ordered_list_open': {
        const declared = Number(token.attrGet('start') ?? 1);
        const start = Number.isSafeInteger(declared) && declared >= 0 ? declared : 1;
        const node: MutableNode = { type: 'orderedList', attrs: { start }, content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'list_item_open': {
        itemStart = true;
        const node: MutableNode = { type: 'listItem', content: [] };
        add(node);
        stack.push(node);
        break;
      }
      case 'heading_close':
      case 'paragraph_close':
      case 'blockquote_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
        stack.pop();
        break;
      case 'hr':
        add({ type: 'horizontalRule' });
        break;
      case 'fence':
      case 'code_block': {
        const info = token.info.trim();
        if (info.length > 0 && !CODE_LANGUAGE.test(info)) {
          // A full info string may carry more than a language token; rather than discard the
          // remainder, the fenced source is preserved as written.
          add(preservedBlock(sourceOf(lines, token)));
          break;
        }
        const text = token.content.replace(/\n$/u, '');
        add({
          type: 'codeBlock',
          attrs: { language: info.length > 0 ? info : null },
          content: text.length > 0 ? [{ type: 'text', text }] : [],
        });
        break;
      }
      case 'inline': {
        if (itemStart && TASK_MARKER.test(token.content)) degraded.add('task_list');
        itemStart = false;
        const parent = top();
        const content = (parent.content ??= []);
        // Never spread: an inline run can hold hundreds of thousands of nodes.
        for (const node of convertInline(token, degraded)) content.push(node);
        break;
      }
      default: {
        if (PRESERVED_BLOCKS.has(token.type)) {
          degraded.add(token.type === 'table_open' ? 'table' : 'raw_html');
          add(preservedBlock(sourceOf(lines, token)));
          if (token.type === 'table_open') skipUntil = 'table_close';
          break;
        }
        if (IGNORED.has(token.type) || token.type.endsWith('_close')) break;
        // Anything unclassified is refused rather than silently dropped by a default branch.
        return { type: '__unsupported', attrs: { token: token.type } };
      }
    }
  }

  const content = root.content ?? [];
  root.content = content.filter(
    (node) => !(node.type === 'paragraph' && (node.content?.length ?? 0) === 0),
  );
  if (root.content.length === 0) root.content.push({ type: 'paragraph' });
  return root;
};

/** A converted document and the constructs it kept as source, in `DEGRADED_CONSTRUCTS` order. */
export interface MarkdownImport {
  readonly document: CanonicalDocument;
  readonly degraded: readonly DegradedConstruct[];
}

/**
 * Converts Markdown to a canonical document and reports what it degraded. Markdown input is best
 * effort in the sense that unsupported *structure* is preserved as source where the parser gives us
 * the source to preserve — not in the sense that conversion always succeeds.
 */
export const importMarkdown = (markdown: string): Either.Either<MarkdownImport, ContentFailure> => {
  const parsed = tokenizeMarkdown(markdown);
  if (Either.isLeft(parsed)) return Either.left(parsed.left);

  const degraded: Degraded = new Set();
  const document = convertTokens(parsed.right.tokens, parsed.right.source, degraded);
  if (document.type === '__unsupported') return Either.left(contentFailure('unsupported_node'));

  return Either.map(canonicalizeDocument(document), (canonical) => ({
    document: canonical,
    degraded: DEGRADED_CONSTRUCTS.filter((construct) => degraded.has(construct)),
  }));
};

/** `importMarkdown` for a caller that needs only the document, as the server does. */
export const fromMarkdown = (markdown: string): Either.Either<CanonicalDocument, ContentFailure> =>
  Either.map(importMarkdown(markdown), (result) => result.document);
