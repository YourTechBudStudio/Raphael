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
import { nextReadStamp } from '../../../infrastructure/query/read-stamp.ts';
import type { FavoriteRead } from './toggle.ts';

/**
 * The favorites list, read from the server a page at a time.
 *
 * The server owns membership and order: favorites that are not archived, by title then id. Nothing
 * here filters, sorts or resolves names against the hierarchy; a row is exactly what the page said.
 *
 * Pages are 500 items, the most the contract allows, so an ordinary list of shortcuts arrives in one
 * request. **Each page carries the stamp of the request that produced it**, because the star on each
 * row decides from it whether that row can have seen a confirmed change (`toggle.ts`). A next page
 * gets a new stamp and the pages before it keep theirs; a full refetch - after any favorite change,
 * on focus, or on Retry - re-requests every page and so re-stamps them all. A refetch that fails keeps
 * the previous pages, with their old stamps.
 *
 * The transport is captured from the session at render, as the notes feed does, so a list read under
 * one connection stays a read of that connection's server.
 *
 * Separated from the hook in `list.ts` for the reason `resources/client/options.ts` is: what this
 * promises about pages, stamps and the next-page guard is a promise about how the query library
 * behaves under these options, and a test can drive it against a real client and a real server with
 * no renderer and no connection store in the way. Private to the capability.
 */

const FAVORITES = 'favorites';

/** One page, and when it was asked for. */
export interface FavoritePage {
  readonly page: ListResponse;
  /** The `nextReadStamp()` taken just before this page was requested. */
  readonly requestedAt: number;
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
 * Pages are not a snapshot across requests, so one node can be on two of them: page 1 returns A and
 * B, B is renamed to sort after C, and page 2 returns C and B. Only the copy from the most recently
 * requested page is kept - its title, its place in the order and its stamp are the newest this phone
 * has - and the list keeps page order otherwise. Row keys are node ids, so this is also what keeps
 * each row's star attached to one node. A node that moved the other way, from page 2's range into
 * page 1's, can be missed until the next refresh: the accepted cost of paging without a snapshot.
 *
 * An item that is not a container cannot arrive, because the server refuses to favorite a note. One
 * is dropped rather than drawn, as search drops a kind it does not know.
 */
export const flattenFavoritePages = (pages: readonly FavoritePage[]): readonly FavoriteItem[] => {
  const items = pages.flatMap(({ page, requestedAt }) =>
    page.items.filter(isContainer).map((node): FavoriteItem => ({
      node,
      read: { id: node.id, isFavorite: node.isFavorite, requestedAt },
    })),
  );
  const newest = new Map<number, FavoriteItem>();

  for (const item of items) {
    const held = newest.get(item.node.id);

    if (held === undefined || item.read.requestedAt > held.read.requestedAt) {
      newest.set(item.node.id, item);
    }
  }

  return items.filter((item) => newest.get(item.node.id) === item);
};

/** Everything the paged favorites read is. Built from the transport the session held at render. */
export const favoritePagesOptions = (activation: number, transport: Transport | null) =>
  infiniteQueryOptions({
    queryKey: scopeKey(activation, FAVORITES),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<FavoritePage> => {
      if (transport === null) throw new Error('No connection');

      // Taken before the request leaves, so the stamp says when the server was asked, not when it
      // answered. See `toggle.ts` for why that is the order that matters.
      const requestedAt = nextReadStamp();
      const page = unwrap(
        await listFavorites(transport, { skip: pageParam, limit: LIST_LIMIT_MAX }, signal),
      );

      return { page, requestedAt };
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
