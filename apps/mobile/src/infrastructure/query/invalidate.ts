import type { QueryClient } from '@tanstack/react-query';

import { activationOf } from './keys.ts';

/**
 * Every query made under one activation, marked stale and refetched where something is reading it.
 *
 * For a change whose reach the client cannot enumerate. Archive and restore change which nodes every
 * list, feed, search and hierarchy read contains, and why each one is archived, and nothing short of
 * the server can say which cached reads that touches. It lives here rather than beside those
 * actions because the screens that import them are the modules whose reads it refreshes.
 */
export const invalidateActivation = (client: QueryClient, activation: number): Promise<void> =>
  client.invalidateQueries({ predicate: (query) => activationOf(query.queryKey) === activation });
