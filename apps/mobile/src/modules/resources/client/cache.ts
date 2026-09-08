import type { QueryClient } from '@tanstack/react-query';

/** Queries showing resources opt in without exposing their private cache keys. */
export const resourceViewMeta = { containsResources: true } as const;

/** A successful resource write makes every resource projection stale, including inactive views. */
export function invalidateResourceViews(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => query.meta?.['containsResources'] === true,
  });
}
