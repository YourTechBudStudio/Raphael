/**
 * Which containers a move may offer, as pruning rather than disabling.
 *
 * A resource may go into any area or project. A project may go into any area. An area may go into any
 * area except itself and everything beneath it. Only areas survive the rules for a container, and every
 * eligible node's ancestors are areas and therefore eligible themselves, so pruning never orphans a
 * row and the tree needs no disabled state.
 *
 * **Presentation only.** The server decides whether a place can hold something; this decides only
 * what is worth offering from the tree this phone last read. A stale tree that offers a place that has
 * since become invalid gets the server's refusal, shown in the sheet.
 */

import type { NodeType } from '@raphael/contracts/nodes';

import type { HierarchyNode } from '../collections/hierarchy';

export const eligibleDestinations = (
  roots: readonly HierarchyNode[],
  entity: { readonly type: NodeType; readonly id: number },
): readonly HierarchyNode[] => {
  if (entity.type === 'resource') return roots;

  // An area's own subtree goes with the area itself: nothing beneath a pruned node is visited.
  const prune = (nodes: readonly HierarchyNode[]): HierarchyNode[] =>
    nodes.flatMap((node) =>
      node.type !== 'area' || node.id === entity.id
        ? []
        : [{ ...node, children: prune(node.children) }],
    );

  return prune(roots);
};

/** Only an area may live at the root, so only an area is offered the top level. */
export const offersRoot = (type: NodeType): boolean => type === 'area';
