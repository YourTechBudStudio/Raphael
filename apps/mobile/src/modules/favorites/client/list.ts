import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useConnectionSession } from '../../connection';
import {
  favoritePagesOptions,
  flattenFavoritePages,
  requestMoreFavorites,
  type FavoriteItem,
} from './options.ts';

export type { FavoriteItem, FavoriteNode } from './options.ts';

export interface FavoritePages {
  /**
   * Every loaded item, in server order, each stamped with its own page's request, and each node at
   * most once (see `flattenFavoritePages`). Undefined until the first page has arrived.
   */
  readonly items: readonly FavoriteItem[] | undefined;
  readonly isPending: boolean;
  /** The first page failed and nothing is loaded. */
  readonly isError: boolean;
  /** A refresh failed over pages still shown; they are true but may not be current. */
  readonly isStale: boolean;
  /** A later page failed. */
  readonly isMoreError: boolean;
  /** Every page is loaded: no page failed and the last said `hasMore: false`. */
  readonly isComplete: boolean;
  /** Any read of the list: the first page, a next page, or a refetch of the held pages. */
  readonly isFetching: boolean;
  /** Asks for the next page, if asking is right. Safe to call repeatedly. */
  readonly loadMore: () => void;
  /** What the person pressed Retry for: the page that failed, else the whole list. */
  readonly retry: () => void;
}

/**
 * The favorites list. With `complete`, it keeps asking until every page is loaded, which is what the
 * text filter needs before it can say that nothing matches.
 */
export function useFavoritePages({ complete }: { complete: boolean }): FavoritePages {
  const session = useConnectionSession();
  const query = useInfiniteQuery(
    favoritePagesOptions(session?.activation ?? -1, session?.transport ?? null),
  );
  const { hasNextPage, isFetching, isFetchNextPageError, isRefetchError, fetchNextPage, refetch } =
    query;
  const gate = { hasNextPage, isFetching, isFetchNextPageError, isRefetchError, fetchNextPage };

  // Runs again whenever one of the guard's inputs changes. While a refresh runs it asks for nothing;
  // once the refresh settles `isFetching` changes, and loading continues from the refreshed pages.
  // The reverse overlap needs nothing: if a favorite change invalidates the list while a next page is
  // loading, the refetch cancels that page and re-reads the pages held, and this then loads the rest.
  // A refresh that failed pauses it until Retry, for the reason `requestMoreFavorites` gives.
  useEffect(() => {
    if (!complete) return;

    requestMoreFavorites({
      hasNextPage,
      isFetching,
      isFetchNextPageError,
      isRefetchError,
      fetchNextPage,
    });
  }, [complete, hasNextPage, isFetching, isFetchNextPageError, isRefetchError, fetchNextPage]);

  return {
    items: query.data === undefined ? undefined : flattenFavoritePages(query.data.pages),
    isPending: query.isPending,
    isError: query.isError && query.data === undefined,
    isStale: isRefetchError,
    isMoreError: isFetchNextPageError,
    isComplete: query.data !== undefined && !hasNextPage && !isFetchNextPageError,
    isFetching,
    loadMore: () => {
      requestMoreFavorites(gate);
    },
    // Always something the person pressed, so it is allowed to cancel a page request in flight: a
    // whole-list refetch is the more current reading.
    retry: () => {
      if (isFetchNextPageError) {
        void fetchNextPage({ cancelRefetch: false });

        return;
      }

      void refetch();
    },
  };
}
