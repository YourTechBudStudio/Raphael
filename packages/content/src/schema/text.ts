import type { CanonicalDocument } from '../index.ts';

/**
 * Derives plain text from a canonical document.
 *
 * These are *the current extraction semantics*, not a permanent contract: the search story may
 * revise them deliberately and rebuild derived indexes, which requires fixture updates and recorded
 * reasoning rather than being a silent change.
 *
 * - Code and Mermaid source are included; people search for code.
 * - Link text is included; the destination URL is not appended.
 * - Whitespace authored inside a block — a blank line in code or Mermaid source, a run of hard
 *   breaks — is emitted as written. Nothing is collapsed globally.
 * - Blocks are separated by a single newline. That separator is *generated*, so it is suppressed
 *   when the block's own content already ended in one; it never removes authored newlines.
 * - A horizontal rule contributes a boundary, never decorative characters.
 * - Newlines at the two document edges are trimmed, deliberately. Derived text is search input, not
 *   a copy of the body: canonical storage and fenced Markdown source preservation are separate and
 *   stronger obligations, and neither is weakened by this trim.
 *
 * The walk is iterative and takes an already-validated document, so it neither recurses without
 * bound nor revalidates inside a pipeline that has already validated.
 */

const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'listItem',
  'blockquote',
  'horizontalRule',
]);

interface Step {
  readonly node: Record<string, unknown>;
  readonly closing: boolean;
}

export const deriveText = (document: CanonicalDocument): string => {
  const parts: string[] = [];
  // Whether the text emitted so far already ends in a newline. Tracked as it is written, because
  // the alternative — scanning back through the parts at every block close, past however many empty
  // blocks precede it — answers the same question at a cost that grows with the document.
  let endsWithNewline = true;
  const emit = (value: string): void => {
    if (value === '') return;
    parts.push(value);
    endsWithNewline = value.endsWith('\n');
  };
  const stack: Step[] = [{ node: document as unknown as Record<string, unknown>, closing: false }];

  while (stack.length > 0) {
    const step = stack.pop();
    if (step === undefined) break;
    const { node, closing } = step;
    const type = node['type'];

    if (closing) {
      if (typeof type === 'string' && BLOCK_NODES.has(type) && !endsWithNewline) emit('\n');
      continue;
    }

    if (type === 'text') {
      const text = node['text'];
      if (typeof text === 'string') emit(text);
      continue;
    }
    if (type === 'hardBreak') {
      // Authored, not generated: a run of hard breaks is a run of newlines.
      parts.push('\n');
      endsWithNewline = true;
      continue;
    }

    stack.push({ node, closing: true });
    const content = node['content'];
    if (Array.isArray(content)) {
      for (let index = content.length - 1; index >= 0; index -= 1) {
        const child = content[index];
        if (typeof child === 'object' && child !== null) {
          stack.push({ node: child as Record<string, unknown>, closing: false });
        }
      }
    }
  }

  // Only the document edges are trimmed. Everything between them is what was emitted.
  return parts.join('').replace(/^\n+|\n+$/g, '');
};
