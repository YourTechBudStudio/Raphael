import type { HierarchyNode } from '../../collections';

/**
 * Narrows the tree to the nodes whose title matches, keeping their ancestors visible so a match is
 * never orphaned. A matching node keeps its whole subtree, so you can still walk below it.
 *
 * This filters exactly what is loaded, and what is loaded is the complete hierarchy: the tree is
 * only ever published once every page has arrived, so "no matches" here means no matches, not
 * "nothing has arrived yet".
 */
export function filterTree(
  nodes: readonly HierarchyNode[],
  query: string,
): readonly HierarchyNode[] {
  const needle = query.trim().toLowerCase();

  if (needle === '') return nodes;

  const result: HierarchyNode[] = [];

  for (const node of nodes) {
    if (node.title.toLowerCase().includes(needle)) {
      result.push(node);
      continue;
    }

    const children = filterTree(node.children, query);

    if (children.length > 0) result.push({ ...node, children });
  }

  return result;
}
