import type { QueryClient } from '@tanstack/react-query';

import { activationOf, isNodeKey } from './keys.ts';

/**
 * Every query made under one activation, marked stale and refetched where something is reading it.
 *
 * For a change whose reach the client cannot enumerate: archive, restore and anything written through
 * `unsent` change what lists, feeds, search and the hierarchy hold. The editor's node reads are left
 * alone (see `nodeKey`).
 */
export const invalidateActivation = (client: QueryClient, activation: number): Promise<void> =>
  client.invalidateQueries({
    predicate: (query) => activationOf(query.queryKey) === activation && !isNodeKey(query.queryKey),
  });
