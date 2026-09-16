/**
 * Normalizes hard-break placement.
 *
 * `hardBreak` is inline content, so the schema accepts one anywhere inline — but CommonMark cannot
 * express every placement, and the ones it cannot express do not fail loudly. They come back as
 * something else:
 *
 * - A break that ends a block has no encoding. `a\` at the end of a paragraph is a literal
 *   backslash, so the break returns as text and is gone.
 * - A break inside a heading has no encoding either, because an ATX heading is one line. `## a\`
 *   followed by `b` returns as a heading *and a separate paragraph* — a change of block structure,
 *   not of spelling. `<br>` is not an alternative: the parser runs with `html: false`, so it would
 *   return as the literal text `a<br>b`.
 *
 * A mark on the break itself has no encoding either, in any position. A break carrying `bold`
 * between two unmarked runs exports as a bare `a\` — the mark leaves no trace in the Markdown at
 * all, so no importer can recover it — and a break whose mark does not continue onto the next node
 * is written outside that mark's delimiters. `prosemirror-markdown` reaches the same conclusion from
 * the other side: `renderInline` strips marks from a break that is the last node inside one.
 *
 * Three rules therefore run before a document is stored:
 *
 * 1. A break that ends a paragraph or heading is dropped. It renders as nothing in that position,
 *    so nothing a reader sees is lost.
 * 2. A break remaining inside a heading becomes a space, carrying the break's own marks so that a
 *    link or emphasis spanning it keeps its extent. A space is text, and text can carry a mark
 *    expressibly.
 * 3. A break that remains a break carries no marks. A line break renders as a line break whether or
 *    not it is bold, so nothing a reader sees is lost here either — unlike the mark itself, which
 *    would be lost on the next read and silently.
 *
 * Placement is otherwise untouched: breaks inside a paragraph or a list item are exactly what a hard
 * break is for, and they round-trip.
 *
 * This runs during canonicalization rather than during export, for the same reason
 * `normalizeMarkBoundaries` does: a stored document then already has the property, storage and
 * export agree, and what a client reads back is what was stored. Rewriting at export time would
 * leave the loss where it is today — invisible, after storage, on every read.
 *
 * Recursion is safe here, as it is there: this runs after the depth bound has been enforced.
 */

const NORMALIZED_BLOCKS = new Set(['paragraph', 'heading']);

const isHardBreak = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)['type'] === 'hardBreak';

/** A space standing in for a break, keeping whatever marks the break carried. */
const spaceFor = (node: Record<string, unknown>): Record<string, unknown> => {
  const marks = node['marks'];
  return marks === undefined ? { type: 'text', text: ' ' } : { type: 'text', text: ' ', marks };
};

export const normalizeHardBreakPlacement = (document: unknown): unknown => {
  const visit = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const node = value as Record<string, unknown>;
    const content = node['content'];
    if (!Array.isArray(content)) return node;

    let changed = false;
    let rebuilt: unknown[] = content.map((child) => {
      const visited = visit(child);
      if (visited !== child) changed = true;
      return visited;
    });

    if (typeof node['type'] === 'string' && NORMALIZED_BLOCKS.has(node['type'])) {
      // Trailing breaks go first, so a heading that merely ends with one loses it rather than
      // gaining a trailing space.
      let end = rebuilt.length;
      while (end > 0 && isHardBreak(rebuilt[end - 1])) end -= 1;
      if (end !== rebuilt.length) {
        rebuilt = rebuilt.slice(0, end);
        changed = true;
      }

      if (node['type'] === 'heading') {
        rebuilt = rebuilt.map((child) => {
          if (!isHardBreak(child)) return child;
          changed = true;
          return spaceFor(child as Record<string, unknown>);
        });
      }

      // Whatever is still a break carries no marks. This runs after the heading rule, so a heading's
      // replacement space keeps the marks the break was carrying.
      rebuilt = rebuilt.map((child) => {
        if (!isHardBreak(child)) return child;
        const breakNode = child as Record<string, unknown>;
        if (breakNode['marks'] === undefined) return child;
        changed = true;
        return { type: 'hardBreak' };
      });
    }

    return changed ? { ...node, content: rebuilt } : node;
  };

  return visit(document);
};
