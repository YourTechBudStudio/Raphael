import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import type { FavoriteRef, ParentRef } from '../../../infrastructure/api/contracts';
import { resourceViewMeta } from '../../resources';

const queryKeys = {
  favorites: ['favorites'] as const,
  browseTree: ['browse-tree'] as const,
  area: (id: string) => ['area', id] as const,
  areaContents: (id: string) => ['area', id, 'contents'] as const,
  project: (id: string) => ['project', id] as const,
  projectContents: (id: string) => ['project', id, 'contents'] as const,
  locationPath: (target: ParentRef | null) =>
    ['location-path', target === null ? 'none' : `${target.type}:${target.id}`] as const,
};

/**
 * A container was created under `parentAreaId`: the parent's contents, the tree, and every
 * favorites-style projection of names are stale. Search is not cached, so nothing to do there.
 */
export function invalidateHierarchy(
  client: QueryClient,
  parentAreaId: string | null,
): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.browseTree }),
    parentAreaId === null
      ? Promise.resolve()
      : client.invalidateQueries({ queryKey: queryKeys.areaContents(parentAreaId) }),
  ]).then(() => undefined);
}

export function useArea(id: string) {
  return useQuery({
    queryKey: queryKeys.area(id),
    queryFn: () => mobileApi.getArea(id),
    enabled: id !== '',
  });
}

export function useAreaContents(id: string) {
  return useQuery({
    queryKey: queryKeys.areaContents(id),
    queryFn: () => mobileApi.getAreaContents(id),
    meta: resourceViewMeta,
    enabled: id !== '',
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => mobileApi.getProject(id),
    enabled: id !== '',
  });
}

export function useProjectContents(id: string) {
  return useQuery({
    queryKey: queryKeys.projectContents(id),
    queryFn: () => mobileApi.getProjectContents(id),
    meta: resourceViewMeta,
    enabled: id !== '',
  });
}

export function useBrowseTree() {
  return useQuery({ queryKey: queryKeys.browseTree, queryFn: () => mobileApi.getBrowseTree() });
}

export function useFavorites() {
  return useQuery({ queryKey: queryKeys.favorites, queryFn: () => mobileApi.getFavorites() });
}

/** Ancestors from the root collection down to the requested location. */
export function useLocationPath(target: ParentRef | null) {
  return useQuery({
    queryKey: queryKeys.locationPath(target),
    queryFn: () => (target === null ? Promise.resolve([]) : mobileApi.getLocationPath(target)),
    enabled: target !== null,
  });
}

export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ref: FavoriteRef) => mobileApi.toggleFavorite(ref),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.favorites });
    },
  });
}
