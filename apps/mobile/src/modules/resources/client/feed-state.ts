/**
 * Six states a note feed can be in, told apart once.
 *
 * They are genuinely different things and a screen that collapses any two of them lies. "Nothing has
 * arrived yet" is not "there are no notes". "There are no notes" is not "the notes could not be
 * read". And a page that failed to load is not a feed that failed: the cards already on screen are
 * still true, and clearing them would throw away a good reading because a later one went wrong.
 *
 * This is a pure function over what the query observed, so the distinctions can be tested without a
 * server, a renderer or a clock, and so the section components below cannot each invent their own
 * version of the same six questions.
 */

import type { NotePage } from './requests.ts';
import type { NoteSummaryItem } from './summary.ts';

/** What the query observed. A narrow structural subset of the infinite-query result. */
export interface NoteQueryObservation {
  readonly pages: readonly NotePage[] | undefined;
  /** Nothing has ever arrived for this key. */
  readonly isPending: boolean;
  /** The most recent read failed, whether or not earlier ones succeeded. */
  readonly isError: boolean;
  /** The failure was a next-page request specifically. */
  readonly isFetchNextPageError: boolean;
  readonly isFetchingNextPage: boolean;
  readonly hasNextPage: boolean;
}

export interface NoteFeedView {
  /** Every note across the pages fetched so far, in the server's sequence. */
  readonly items: readonly NoteSummaryItem[];
  /** Nothing has arrived and nothing has failed: show the skeleton, say nothing. */
  readonly isLoading: boolean;
  /** Nothing arrived and the read failed. There are no cards, so the line stands alone. */
  readonly isUnavailable: boolean;
  /** Successfully read, and there is nothing filed here. */
  readonly isEmpty: boolean;
  /**
   * Cards are on screen from an earlier reading and a later read of the same list failed. The cards
   * stay; the line beside them says what is not known.
   */
  readonly isStale: boolean;
  /** The next page failed. Earlier cards are untouched and the end of the list says so. */
  readonly nextPageFailed: boolean;
  /** A next page is on its way. The loading row is the only statement of incompleteness. */
  readonly isLoadingMore: boolean;
  /** Reaching the end should ask for another page: there is one, and none is already in flight. */
  readonly canLoadMore: boolean;
}

export const deriveNoteFeed = (observation: NoteQueryObservation): NoteFeedView => {
  const items = (observation.pages ?? []).flatMap((page) => page.items);
  const arrived = observation.pages !== undefined;

  // A failed *next page* is not a failed feed. It is the only failure that leaves `hasNextPage`
  // meaningful, and the only one whose report belongs at the bottom of the list rather than beside
  // the heading.
  const nextPageFailed = observation.isError && observation.isFetchNextPageError;
  const readFailed = observation.isError && !observation.isFetchNextPageError;

  return {
    items,
    isLoading: observation.isPending && !observation.isError,
    isUnavailable: !arrived && observation.isError,
    isEmpty: arrived && !observation.isError && items.length === 0,
    isStale: arrived && readFailed,
    nextPageFailed: arrived && nextPageFailed,
    isLoadingMore: observation.isFetchingNextPage,
    // A failed next page stops the automatic walk. Scrolling into the same failure repeatedly would
    // spend requests on a server that has already said no, so the retry is the person's pull-down.
    canLoadMore: observation.hasNextPage && !observation.isFetchingNextPage && !nextPageFailed,
  };
};
