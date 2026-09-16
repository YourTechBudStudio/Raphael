import { Either } from 'effect';
import type { Token } from 'markdown-it';

import { contentFailure, type ContentFailure } from '../failures.ts';
import type { CanonicalDocument } from '../index.ts';
import { canonicalizeDocument } from '../schema/canonicalize.ts';
import { CODE_LANGUAGE, isAllowedHref } from '../validation/index.ts';
import { linkDestination } from './escape.ts';
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
 */

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

/**
 * Inline conversion. Marks are tracked on an explicit stack rather than by recursion, and a link
 * whose destination fails policy degrades to its literal Markdown source instead of becoming a
 * clickable mark or rejecting the whole import.
 */
const convertInline = (token: Token): MutableNode[] => {
  const out: MutableNode[] = [];
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  const push = (
    text: string,
    withMarks: readonly { type: string; attrs?: Record<string, unknown> }[] = marks,
  ): void => {
    if (text.length > 0) out.push(textNode(text, withMarks));
  };

  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        push(child.content);
        break;
      case 'code_inline':
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
        marks.push(
          isAllowedHref(href)
            ? { type: 'link', attrs: { href } }
            : { type: REJECTED_LINK, attrs: { href: href ?? '' } },
        );
        break;
      }
      case 'link_close':
        marks.pop();
        break;
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

  return out.map((node) => {
    if (node.type !== 'text' || node.marks === undefined) return node;
    const rejected = node.marks.find((mark) => mark.type === REJECTED_LINK);
    if (rejected === undefined) return node;
    const kept = node.marks.filter((mark) => mark.type !== REJECTED_LINK);
    return textNode(`[${node.text ?? ''}](${String(rejected.attrs?.['href'] ?? '')})`, kept);
  });
};

const HEADING_LEVELS = new Set([1, 2, 3]);

const convertTokens = (tokens: readonly Token[], source: string): MutableNode => {
  const lines = source.split('\n');
  const root: MutableNode = { type: 'doc', content: [] };
  const stack: MutableNode[] = [root];
  const top = (): MutableNode => stack[stack.length - 1] ?? root;
  const add = (node: MutableNode): void => {
    (top().content ??= []).push(node);
  };
  let skipUntil: string | null = null;

  for (const token of tokens) {
    if (skipUntil !== null) {
      if (token.type === skipUntil) skipUntil = null;
      continue;
    }
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1));
        if (!HEADING_LEVELS.has(level)) {
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
        const parent = top();
        const content = (parent.content ??= []);
        // Never spread: an inline run can hold hundreds of thousands of nodes.
        for (const node of convertInline(token)) content.push(node);
        break;
      }
      default: {
        if (PRESERVED_BLOCKS.has(token.type)) {
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

/**
 * Converts Markdown to a canonical document. Markdown input is best effort in the sense that
 * unsupported *structure* is preserved as source where the parser gives us the source to preserve —
 * not in the sense that conversion always succeeds.
 */
export const fromMarkdown = (
  markdown: string,
): Either.Either<CanonicalDocument, ContentFailure> => {
  const parsed = tokenizeMarkdown(markdown);
  if (Either.isLeft(parsed)) return Either.left(parsed.left);

  const document = convertTokens(parsed.right.tokens, parsed.right.source);
  if (document.type === '__unsupported') return Either.left(contentFailure('unsupported_node'));

  return canonicalizeDocument(document);
};
