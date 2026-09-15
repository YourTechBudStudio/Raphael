/** THROWAWAY MOCK. The mock tree, including containers created in this session, as Browse reads it. */

import type { Hierarchy, HierarchyNode } from '../collections';
import { MOCK_TREE, toHierarchyNodes, withCreated, type MockNode } from './data';

export const mockHierarchyRoots = (
  created: readonly { node: MockNode; parentId: number | null }[],
): readonly HierarchyNode[] => toHierarchyNodes(withCreated(MOCK_TREE, created));

/** The same tree as a lookup-able hierarchy, for Search. */
export const mockHierarchy = (
  created: readonly { node: MockNode; parentId: number | null }[],
): Hierarchy => {
  const roots = mockHierarchyRoots(created);
  const byId = new Map<number, HierarchyNode>();
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      byId.set(node.id, node);
      walk(node.children);
    }
  };
  walk(roots);

  return { roots, byId };
};
