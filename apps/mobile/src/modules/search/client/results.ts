import { useMemo } from 'react';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import {
  subtreeIds,
  useHierarchy,
  type Hierarchy,
  type HierarchyNode,
  type HierarchyQuery,
} from '../../collections';

/**
 * Search, over what this app actually has.
 *
 * Areas and projects, and nothing else. They are searched by filtering the loaded hierarchy, because
 * there is no server search operation in this release and inventing one here would mean this client
 * deciding what "matching" means - the server's job to define once rather than each client's to
 * guess.
 *
 * Notes are deliberately not searched. They used to be, over a session-only store that held whatever
 * this process had captured; against a server that holds all of them, filtering the handful this app
 * happens to have read would return an answer shaped exactly like a complete one. The screen says
 * they are not searched instead. Server-side note search is story #6.
 *
 * Container results inherit the hierarchy's loading and failure states exactly. A hierarchy that did
 * not load must never read as "no matching areas or projects": one is a fact about the server, the
 * other is a claim about someone's data, and they look identical on screen if they are not kept
 * apart here.
 */

export interface SearchResults {
  readonly containers: readonly HierarchyNode[];
}

export interface SearchState {
  readonly results: SearchResults;
  readonly isPending: boolean;
  /** The hierarchy could not be read at all, so container results are unknown, not empty. */
  readonly containersFailed: boolean;
  /** The hierarchy query itself, so a container failure is reported the way it is everywhere else. */
  readonly tree: HierarchyQuery;
  readonly isFetching: boolean;
  /** The containers being searched come from a complete but no longer current reading. */
  readonly isStale: boolean;
  /** True when the scope was given but is not in the hierarchy, so everything was searched. */
  readonly scopeMissing: boolean;
  readonly scopeName: string | undefined;
  readonly refetch: () => void;
}

const EMPTY: SearchResults = { containers: [] };

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

const searchHierarchy = (
  hierarchy: Hierarchy,
  needle: string,
  scopeIds: ReadonlySet<number> | null,
): readonly HierarchyNode[] => {
  const found: HierarchyNode[] = [];

  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      const inScope = scopeIds === null || scopeIds.has(node.id);

      if (inScope && (matches(node.title, needle) || matches(node.description, needle))) {
        found.push(node);
      }

      walk(node.children);
    }
  };

  walk(hierarchy.roots);

  return found;
};

export function useSearch(query: string, scope: ContainerRef | null): SearchState {
  const tree = useHierarchy();
  const hierarchy = tree.hierarchy;

  const needle = query.trim().toLowerCase();

  const scopeNode = scope === null ? undefined : hierarchy?.byId.get(scope.id);
  // A scope that is not in a *loaded* hierarchy is genuinely not there. While the hierarchy is
  // still loading it is unknown, and claiming it is missing then would be a guess.
  const scopeMissing = scope !== null && hierarchy !== undefined && scopeNode === undefined;

  const scopeIds = useMemo(
    () =>
      scope === null || hierarchy === undefined || scopeMissing
        ? null
        : subtreeIds(hierarchy, scope.id),
    [scope, hierarchy, scopeMissing],
  );

  const results = useMemo((): SearchResults => {
    if (needle === '') return EMPTY;

    return {
      containers: hierarchy === undefined ? [] : searchHierarchy(hierarchy, needle, scopeIds),
    };
  }, [needle, hierarchy, scopeIds]);

  return {
    results,
    isPending: needle !== '' && tree.isPending,
    containersFailed: tree.isError && hierarchy === undefined,
    tree,
    isFetching: tree.isFetching,
    isStale: tree.isStale,
    scopeMissing,
    scopeName: scopeNode?.title,
    refetch: () => {
      tree.refetch();
    },
  };
}
