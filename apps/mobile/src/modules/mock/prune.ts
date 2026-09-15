/** THROWAWAY MOCK. */

import type { MockNode } from './data';

/** Keeps the branches that match, or hold a match, so a filtered tree is still a tree. */
export function pruneTree(nodes: readonly MockNode[], needle: string): readonly MockNode[] {
  if (needle === '') return nodes;

  return nodes.flatMap((node) => {
    const children = pruneTree(node.children, needle);
    const matches = node.title.toLowerCase().includes(needle);

    return matches || children.length > 0
      ? [{ ...node, children: matches ? node.children : children }]
      : [];
  });
}
