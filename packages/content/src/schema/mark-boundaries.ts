/**
 * Moves whitespace out of emphasis marks.
 *
 * CommonMark's delimiter-flanking rules make emphasis whose content begins or ends with whitespace
 * inexpressible in general position: `x**&#32;y&#32;**z` and `x** y **z` both parse as literal text,
 * and so does the leading-only form. It works solely at the start of a line, where the preceding
 * position counts as whitespace. There is no delimiter choice that fixes it — `*`, `_` and `~~` all
 * share the rule — so no serializer, grammar-aware or otherwise, can encode such a span.
 *
 * The whitespace is therefore moved outside the mark, which is what established Markdown serializers
 * do: every character is preserved and the rendered result is identical, because emphasized
 * whitespace looks the same as plain whitespace. Only the span of the mark changes.
 *
 * This runs during canonicalization rather than during export, so a stored document already has the
 * property and a document exported and re-imported comes back unchanged. Links and code are
 * untouched: a link label has no flanking rule, and a code span encodes its own padding.
 */

const DELIMITER_MARKS = new Set(['bold', 'italic', 'strike']);
const EDGE_WHITESPACE = /^(\s*)([\s\S]*?)(\s*)$/u;

interface MarkLike {
  readonly type?: unknown;
  readonly attrs?: Record<string, unknown>;
}

const hasDelimiterMark = (marks: readonly MarkLike[]): boolean =>
  marks.some((mark) => typeof mark.type === 'string' && DELIMITER_MARKS.has(mark.type));

const withoutDelimiterMarks = (marks: readonly MarkLike[]): MarkLike[] =>
  marks.filter((mark) => !(typeof mark.type === 'string' && DELIMITER_MARKS.has(mark.type)));

const textNode = (text: string, marks: readonly MarkLike[]): Record<string, unknown> =>
  marks.length > 0 ? { type: 'text', text, marks: [...marks] } : { type: 'text', text };

/** Splits one text node into up to three, so emphasis covers only the non-whitespace span. */
const splitNode = (node: Record<string, unknown>): Record<string, unknown>[] => {
  const text = node['text'];
  const marks = (node['marks'] ?? []) as readonly MarkLike[];
  if (typeof text !== 'string' || !hasDelimiterMark(marks)) return [node];

  const match = EDGE_WHITESPACE.exec(text);
  if (match === null) return [node];
  const [, leading = '', core = '', trailing = ''] = match;
  if (leading === '' && trailing === '') return [node];

  const outer = withoutDelimiterMarks(marks);
  const parts: Record<string, unknown>[] = [];
  if (leading !== '') parts.push(textNode(leading, outer));
  // Emphasis covering only whitespace carries no meaning, so it is dropped rather than relocated.
  if (core !== '') parts.push(textNode(core, marks));
  if (trailing !== '') parts.push(textNode(trailing, outer));
  return parts;
};

/**
 * Rewrites a document so no emphasis mark begins or ends with whitespace, rebuilding only the
 * content arrays that actually change.
 *
 * Recursion is safe here, unlike in validation: this runs after the depth bound has been enforced,
 * so nesting is already limited to a depth the stack handles comfortably.
 */
export const normalizeMarkBoundaries = (document: unknown): unknown => {
  const visit = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const node = value as Record<string, unknown>;
    const content = node['content'];
    if (!Array.isArray(content)) return node;

    const rebuilt: unknown[] = [];
    let changed = false;
    for (const child of content) {
      const visited = visit(child);
      if (visited !== child) changed = true;
      if (typeof visited === 'object' && visited !== null && !Array.isArray(visited)) {
        const parts = splitNode(visited as Record<string, unknown>);
        if (parts.length !== 1 || parts[0] !== visited) changed = true;
        for (const part of parts) rebuilt.push(part);
        continue;
      }
      rebuilt.push(visited);
    }
    return changed ? { ...node, content: rebuilt } : node;
  };

  return visit(document);
};
