import type { CanonicalDocument } from '../index.ts';
import { codeSpan, encodeBoundaryWhitespace, escapeText, linkDestination } from './escape.ts';

/**
 * Markdown export.
 *
 * Owned rather than delegated because the obvious library serializer wrapped preserved source in a
 * three-backtick fence even when the source itself contained three backticks, so a preserved block
 * corrupted and accumulated wrapping on every round trip — a defect on exactly the blocks the
 * preservation policy depends on.
 *
 * Export is best effort in fidelity terms: supported text and code content survive, but Markdown
 * syntax is not promised to round-trip byte-for-byte.
 */

interface DocNode {
  readonly type?: unknown;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly unknown[];
  readonly text?: unknown;
  readonly marks?: readonly { readonly type?: unknown; readonly attrs?: Record<string, unknown> }[];
}

/** A fence must be at least three delimiters and always longer than the longest run it contains. */
const fenceFor = (content: string): string => {
  let longest = 0;
  for (const run of content.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
};

const MARK_DELIMITERS: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
};

const asNode = (value: unknown): DocNode => (value ?? {}) as DocNode;

const serializeInline = (nodes: readonly unknown[] = []): string => {
  let out = '';
  for (const value of nodes) {
    const node = asNode(value);
    if (node.type === 'hardBreak') {
      out += '\\\n';
      continue;
    }
    if (node.type !== 'text' || typeof node.text !== 'string') continue;

    const marks = node.marks ?? [];
    const hasCode = marks.some((mark) => mark.type === 'code');
    const link = marks.find((mark) => mark.type === 'link');

    let text = hasCode ? codeSpan(node.text) : escapeText(node.text);
    // Emphasis never begins or ends with whitespace: canonicalization moved it outside the mark,
    // because CommonMark cannot express such a span. A link label has no flanking rule, so its own
    // edge whitespace is encoded here.
    const hasLink = link !== undefined;
    if (!hasCode && hasLink) text = encodeBoundaryWhitespace(text);
    for (const mark of marks) {
      const delimiter = typeof mark.type === 'string' ? MARK_DELIMITERS[mark.type] : undefined;
      if (delimiter !== undefined) text = `${delimiter}${text}${delimiter}`;
    }
    if (link !== undefined) {
      text = `[${text}](${linkDestination(String(link.attrs?.['href'] ?? ''))})`;
    }
    out += text;
  }
  return out;
};

const prefixLines = (text: string, first: string, rest: string): string =>
  text
    .split('\n')
    .map((line, index) => (index === 0 ? first : rest) + line)
    .join('\n');

const serializeBlock = (value: unknown): string => {
  const node = asNode(value);
  switch (node.type) {
    case 'paragraph':
      return encodeBoundaryWhitespace(serializeInline(node.content));
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.['level'] ?? 1))} ${encodeBoundaryWhitespace(serializeInline(node.content))}`;
    case 'horizontalRule':
      return '---';
    case 'codeBlock': {
      const first = asNode(node.content?.[0]);
      const text = typeof first.text === 'string' ? first.text : '';
      const fence = fenceFor(text);
      const language = node.attrs?.['language'];
      return `${fence}${typeof language === 'string' ? language : ''}\n${text}\n${fence}`;
    }
    case 'blockquote':
      return prefixLines(serializeBlocks(node.content), '> ', '> ');
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      const start = ordered ? Number(node.attrs?.['start'] ?? 1) : 0;
      return (node.content ?? [])
        .map((item, index) => {
          const marker = ordered ? `${start + index}. ` : '- ';
          return prefixLines(
            serializeBlocks(asNode(item).content),
            marker,
            ' '.repeat(marker.length),
          );
        })
        .join('\n');
    }
    default:
      return '';
  }
};

const serializeBlocks = (nodes: readonly unknown[] = []): string =>
  nodes
    .map((node) => serializeBlock(node))
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n');

export const toMarkdown = (document: CanonicalDocument): string =>
  serializeBlocks(document.content);
