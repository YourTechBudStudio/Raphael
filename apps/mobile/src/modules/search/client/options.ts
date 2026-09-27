/**
 * The search read as data: the page sequence it walks, and when it may ask for the next page.
 *
 * Separated from the hook for the reason `resources/client/options.ts` is. What this promises about
 * offsets and about never cancelling a read already in the air is a promise about how the query
 * library behaves under these options, and a test can only show that by driving a real client with
 * no renderer and no connection store in the way.
 *
 * Private to the capability.
 */

import { infiniteQueryOptions } from '@tanstack/react-query';

import type { Transport } from '../../../infrastructure/api';
import { fetchSearchPage, searchKey, type SearchDescriptor, type SearchPage } from './requests.ts';

/**
 * Everything one paged search is.
 *
 * `transport` is the one the session held when this was built, so a search issued against one
 * server stays a search against that server however long its pages take.
 */
export const searchPagesOptions = (
  activation: number,
  transport: Transport | null,
  descriptor: SearchDescriptor,
  enabled: boolean,
) =>
  infiniteQueryOptions({
    queryKey: searchKey(activation, descriptor),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }): Promise<SearchPage> => {
      if (transport === null) throw new Error('No connection');

      return fetchSearchPage(transport, descriptor, pageParam, signal);
    },
    // From what the server said about the page it sent, never from how many rows survived the kind
    // guard. A dropped hit still occupied an offset.
    getNextPageParam: (last: SearchPage) => (last.hasMore ? last.skip + last.limit : undefined),
    // A reading of this moment, never a cached one. Nothing invalidates `SEARCH_SEGMENT` on a write
    // and nothing needs to: with no freshness and no retention, the pages are dropped when the modal
    // closes and reopening asks the server again. See `requests.ts`.
    staleTime: 0,
    gcTime: 0,
    enabled: transport !== null && enabled,
  });

/** The part of an infinite-query result the next-page guard consults. */
export interface MoreResultsGate {
  readonly hasNextPage: boolean;
  /** Any read of this search: the first page, a next page, or a refetch of the held pages. */
  readonly isFetching: boolean;
  readonly isFetchNextPageError: boolean;
  readonly fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>;
}

/**
 * Asks for the next page, if asking is the right thing to do. Returns whether it asked.
 *
 * `onEndReached` fires on every qualifying scroll event while the end is on screen, so this is asked
 * repeatedly, and three things make it say no.
 *
 * - **Nothing more:** the last page said the server has nothing after it.
 * - **Any read in flight, not only a next page.** The query library does not collapse overlapping
 *   next-page calls, so two would fetch one offset twice. And a refetch of the held pages - on
 *   return to the app, or a retry - must finish first: a page asked for alongside it would be
 *   placed after pages that are about to be replaced.
 * - **The last page failed.** Scrolling into a refused request again and again would spend requests
 *   on a server that has already said no. The retry is the person's, through `retryMoreResults`.
 *
 * `cancelRefetch: false` for the same refetch. The library's default cancels whatever read of this
 * query is in flight before starting the page, and the page must never cost the held pages their
 * refresh. The `isFetching` check already keeps them apart; this keeps it true if the check and the
 * call ever drift apart in time.
 *
 * Not `resources`' `requestNextPage`: that guard checks only `isFetchingNextPage`, which is enough
 * for a feed nothing else refetches underneath, and not here. The favorites list keeps the same rule
 * as this one, for the same reasons.
 */
export const requestMoreResults = (gate: MoreResultsGate): boolean => {
  if (!gate.hasNextPage || gate.isFetching || gate.isFetchNextPageError) return false;

  void gate.fetchNextPage({ cancelRefetch: false });

  return true;
};

/**
 * Asks again for the page that failed: the Retry beside "More results did not load."
 *
 * Unguarded by the failure, which is the point, but still never cancelling a read in flight.
 */
export const retryMoreResults = (gate: Pick<MoreResultsGate, 'fetchNextPage'>): void => {
  void gate.fetchNextPage({ cancelRefetch: false });
};
