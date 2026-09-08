import type { BrowseNode } from '../../../infrastructure/api/contracts';

/**
 * Narrows the tree to the nodes whose name matches, keeping their ancestors visible so a
 * match is never orphaned. A matching node keeps its whole subtree, so you can still walk
 * below it.
 */
export function filterTree(nodes: readonly BrowseNode[], query: string): BrowseNode[] {
  const needle = query.trim().toLowerCase();

  if (needle === '') {
    return [...nodes];
  }

  const result: BrowseNode[] = [];

  for (const node of nodes) {
    if (node.name.toLowerCase().includes(needle)) {
      result.push(node);
      continue;
    }

    const children = filterTree(node.children, query);

    if (children.length > 0) {
      result.push({ ...node, children });
    }
  }

  return result;
}
