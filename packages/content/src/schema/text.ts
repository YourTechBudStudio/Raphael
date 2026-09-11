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
 * - Code block whitespace is preserved exactly.
 * - Blocks are separated by newlines and hard breaks become newlines.
 * - A horizontal rule contributes a boundary, never decorative characters.
 * - Whitespace is never collapsed globally.
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
  const stack: Step[] = [{ node: document as unknown as Record<string, unknown>, closing: false }];

  while (stack.length > 0) {
    const step = stack.pop();
    if (step === undefined) break;
    const { node, closing } = step;
    const type = node['type'];

    if (closing) {
      if (typeof type === 'string' && BLOCK_NODES.has(type)) parts.push('\n');
      continue;
    }

    if (type === 'text') {
      const text = node['text'];
      if (typeof text === 'string') parts.push(text);
      continue;
    }
    if (type === 'hardBreak') {
      parts.push('\n');
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

  // Block boundaries are emitted per block; collapse the runs they create at block joins only.
  return parts
    .join('')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '');
};
