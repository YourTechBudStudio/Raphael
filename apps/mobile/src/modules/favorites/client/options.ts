import { listFavorites } from '@raphael/client/nodes';
import {
  CONTAINER_TYPES,
  LIST_LIMIT_MAX,
  type ListResponse,
  type NodeSummary,
} from '@raphael/contracts/nodes';
import { infiniteQueryOptions } from '@tanstack/react-query';

import type { Transport } from '../../../infrastructure/api';
import type { ContainerType } from '../../../infrastructure/api/contracts';
import { unwrap } from '../../../infrastructure/query/failure.ts';
import { scopeKey } from '../../../infrastructure/query/keys.ts';
import type { FavoriteRead } from './toggle.ts';

/**
 * The favorites list, read from the server a page at a time.
 *
 * The server owns membership and order: favorites that are not archived, by title then id. Nothing
 * here filters, sorts or resolves names against the hierarchy; a row is exactly what the page said.
 * Pages are 500 items, the most the contract allows, so an ordinary list arrives in one request.
 *
 * Separated from the hook in `list.ts` so a test can drive it against a real client and a real
 * server with no renderer and no connection store in the way. Private to the capability.
 */

const FAVORITES = 'favorites';

/** One page of the favorites list. */
export interface FavoritePage {
  readonly page: ListResponse;
}

/** A favorite is always a container: the server refuses a note. */
export type FavoriteNode = NodeSummary & { readonly type: ContainerType };

export interface FavoriteItem {
  readonly node: FavoriteNode;
  /** The node's favorite state as its own page reported it, for the row's star. */
  readonly read: FavoriteRead;
}

const isContainer = (node: NodeSummary): node is FavoriteNode =>
  (CONTAINER_TYPES as readonly string[]).includes(node.type);

/**
 * The loaded pages as one list, with each node once.
 *
 * Pages are not a snapshot across requests, so one node can be on two of them when it was renamed
 * between them. The copy from the later page is kept - it was requested later - and page order is
 * kept otherwise. A note cannot be a favorite, so anything that is not a container is dropped.
 */
export const flattenFavoritePages = (pages: readonly FavoritePage[]): readonly FavoriteItem[] => {
  const items = pages.flatMap(({ page }) =>
    page.items
      .filter(isContainer)
      .map((node): FavoriteItem => ({ node, read: { id: node.id, isFavorite: node.isFavorite } })),
  );
  const last = new Map<number, FavoriteItem>();

  for (const item of items) last.set(item.node.id, item);

  return items.filter((item) => last.get(item.node.id) === item);
};

/** Everything the paged favorites read is. Built from the transport the session held at render. */
export const favoritePagesOptions = (activation: number, transport: Transport | null) =>
  infiniteQueryOptions({
    queryKey: scopeKey(activation, FAVORITES),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<FavoritePage> => {
      if (transport === null) throw new Error('No connection');

      const page = unwrap(
        await listFavorites(transport, { skip: pageParam, limit: LIST_LIMIT_MAX }, signal),
      );

      return { page };
    },
    // From what the server said about the page it sent, never from how many items survived the
    // container guard. A dropped item still occupied an offset.
    getNextPageParam: (last: FavoritePage) =>
      last.page.hasMore ? last.page.skip + last.page.limit : undefined,
    enabled: transport !== null,
  });

/** The part of an infinite-query result the next-page guard consults. */
export interface MoreFavoritesGate {
  readonly hasNextPage: boolean;
  readonly isFetching: boolean;
  readonly isFetchNextPageError: boolean;
  /** A refetch of the held pages failed, so they may be older than the page that would follow. */
  readonly isRefetchError: boolean;
  readonly fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>;
}

/**
 * Asks for the next page only when nothing else is fetching. The same rule as search's
 * `requestMoreResults`, kept here rather than shared because the two capabilities do not depend on
 * each other.
 *
 * Stricter than the notes feed's guard, on purpose. `fetchNextPage` cancels any fetch already in
 * flight by default, and this list is refreshed by every favorite change. A page request made during
 * that refresh would cancel it, and the list would keep showing what it held before the change. So a
 * page is asked for only when no fetch of any kind is running. `cancelRefetch: false` is a second
 * guard: if a fetch starts in the same tick, this call joins it instead of cancelling it. A failed
 * page stops automatic loading until the person asks again.
 *
 * A failed refresh stops it too. The held pages are then older than any page asked for now, and a
 * page that arrives clears the query's refetch error while keeping those pages. The list would look
 * current and, once the last page came, complete - so a filter could say nothing matches when a
 * match had moved into a page that was never reread. Only Retry, which rereads the held pages, lets
 * loading continue.
 */
export const requestMoreFavorites = (gate: MoreFavoritesGate): void => {
  if (!gate.hasNextPage || gate.isFetching || gate.isFetchNextPageError || gate.isRefetchError) {
    return;
  }

  void gate.fetchNextPage({ cancelRefetch: false });
};
