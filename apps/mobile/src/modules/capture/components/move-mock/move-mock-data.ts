/**
 * Temporary: move mock for story #7. Presentation only: invented data, no server, no owner.
 *
 * Delete this folder, `app/mocks`, the capture export and the Settings link together.
 */

import type { ContainerType } from '../../../../infrastructure/api/contracts';
import type { HierarchyNode } from '../../../collections';

const node = (
  id: number,
  type: ContainerType,
  title: string,
  parentId: number | null,
  children: readonly HierarchyNode[] = [],
): HierarchyNode => ({
  id,
  type,
  parentId,
  slug: title.toLowerCase().replaceAll(' ', '-'),
  revision: 1,
  title,
  description: '',
  active: false,
  children,
});

export const MOCK_ROOTS: readonly HierarchyNode[] = [
  node(1, 'area', 'Work', null, [
    node(11, 'project', 'Raphael', 1),
    node(2, 'area', 'Platform', 1, [
      node(21, 'project', 'Backend', 2),
      node(3, 'area', 'Infrastructure', 2),
    ]),
    node(12, 'project', 'Hiring', 1),
  ]),
  node(4, 'area', 'Personal', null, [
    node(5, 'area', 'Health', 4),
    node(41, 'project', 'Home renovation', 4),
  ]),
  node(6, 'area', 'Reading', null),
];

const byId = new Map<number, HierarchyNode>();
const index = (nodes: readonly HierarchyNode[]): void => {
  for (const each of nodes) {
    byId.set(each.id, each);
    index(each.children);
  }
};
index(MOCK_ROOTS);

export const mockNode = (id: number): HierarchyNode | undefined => byId.get(id);

/** The chain from the top down to `id`, inclusive. */
export const mockAncestors = (id: number): readonly HierarchyNode[] => {
  const chain: HierarchyNode[] = [];
  let current = byId.get(id);
  while (current !== undefined) {
    chain.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }

  return chain;
};

/** The note being moved. */
export const MOCK_NOTE = {
  title: 'Retry budget for the sync loop',
  slug: 'retry-budget',
  parentId: 11,
};
