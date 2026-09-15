import { useMemo } from 'react';

import type { ContainerRef, Resource } from '../../../infrastructure/api/contracts';
import {
  subtreeIds,
  useHierarchy,
  type Hierarchy,
  type HierarchyNode,
  type HierarchyQuery,
} from '../../collections';
import { mockHierarchy, useMockStore } from '../../mock';
import { useLocalResources } from '../../resources';

/**
 * Search, over what this app actually has.
 *
 * Two different sources, and the screen has to be able to tell them apart. Containers are searched
 * by filtering the loaded hierarchy - there is no server search operation in this release, and
 * inventing one here would mean this client deciding what "matching" means, which is the server's
 * job to define once rather than each client's to guess. Notes are searched over the session-only
 * store.
 *
 * Container results therefore inherit the hierarchy's loading and failure states exactly. A
 * hierarchy that did not load must never read as "no matching areas or projects": one is a fact
 * about the server, the other is a claim about someone's data, and they look identical on screen
 * if they are not kept apart here.
 */

export interface SearchResults {
  readonly containers: readonly HierarchyNode[];
  readonly resources: readonly Resource[];
}

export interface SearchState {
  readonly results: SearchResults;
  readonly isPending: boolean;
  /** The hierarchy could not be read at all, so container results are unknown, not empty. */
  readonly containersFailed: boolean;
  /** The hierarchy query itself, so a container failure is reported the way it is everywhere else. */
  readonly tree: HierarchyQuery;
  /** The notes could not be read. */
  readonly resourcesFailed: boolean;
  readonly isFetching: boolean;
  /** The containers being searched come from a complete but no longer current reading. */
  readonly isStale: boolean;
  /** True when the scope was given but is not in the hierarchy, so everything was searched. */
  readonly scopeMissing: boolean;
  readonly scopeName: string | undefined;
  readonly refetch: () => void;
}

const EMPTY: SearchResults = { containers: [], resources: [] };

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
  const notes = useLocalResources();

  // THROWAWAY: Search reads the same mock tree Browse draws while the gallery says so.
  const mockBrowse = useMockStore((state) => state.mockBrowse);
  const created = useMockStore((state) => state.created);
  const mocked = __DEV__ && mockBrowse;
  const hierarchy = useMemo(
    () => (mocked ? mockHierarchy(created) : tree.hierarchy),
    [mocked, created, tree.hierarchy],
  );

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

    const containers = hierarchy === undefined ? [] : searchHierarchy(hierarchy, needle, scopeIds);
    const resources = (notes.data ?? []).filter(
      (resource) =>
        (scopeIds === null || scopeIds.has(resource.parent.id)) &&
        (matches(resource.title, needle) || matches(resource.summary, needle)),
    );

    return { containers, resources };
  }, [needle, hierarchy, scopeIds, notes.data]);

  return {
    results,
    isPending: needle !== '' && ((tree.isPending && !mocked) || notes.isPending),
    containersFailed: tree.isError && hierarchy === undefined && !mocked,
    tree,
    resourcesFailed: notes.isError,
    isFetching: tree.isFetching || notes.isFetching,
    isStale: tree.isStale,
    scopeMissing,
    scopeName: scopeNode?.title,
    refetch: () => {
      tree.refetch();
      void notes.refetch();
    },
  };
}
