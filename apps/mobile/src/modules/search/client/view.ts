/**
 * The states a search can be in, told apart once.
 *
 * A pure function over what the query observed, for the same reason `deriveNoteFeed` is one: the
 * distinctions are the product, and they can be tested without a server, a renderer or a clock. The
 * one this file exists to protect is that **"nothing matched" and "could not search" are different
 * answers**. One is a fact about someone's data, the other is a fact about the server, and they look
 * identical on screen to any code that only knows the request is over.
 *
 * Two more it keeps. A query that has not been sent - empty, or still being typed into a phrase, or
 * refused before it left - reports no results rather than no matches. And a failed next page is not
 * a failed search: the rows already read stay, and the end of the list is never implied while the
 * page after them could not be read.
 */

import type { SearchQueryRejection, TagsRejection } from '@raphael/contracts/nodes';

import { asClientFailure } from '../../../infrastructure/query/failure.ts';
import { flattenSearchPages, type SearchPage, type SearchResultItem } from './requests.ts';

/**
 * The server looked for the scope and it is not there.
 *
 * Narrow on purpose, and narrower than "a 404": only `node_not_found` reported against the `scopes`
 * field is the scope being gone. The same code against another field, or any other failure, is an
 * ordinary failed search with an ordinary retry.
 *
 * This is the one place mobile depends on the contract's own spelling of that failure, so it lives
 * here beside the state it decides rather than inside the hook, where nothing could reach it: if the
 * field is ever reported differently, the screen would silently fall back from "That project is no
 * longer here." to a retry that cannot succeed, which is precisely the state `isScopeGone` exists to
 * prevent. A test holds the spelling in place.
 */
export const isScopeGone = (error: unknown): boolean => {
  const failure = asClientFailure(error);

  return (
    failure?.kind === 'api_error' &&
    failure.error.code === 'node_not_found' &&
    failure.details.field === 'scopes'
  );
};

/**
 * What was refused before a request was made, and which of the two things was refused.
 *
 * Tagged rather than left as a bare union of the two contract types. They have no common
 * discriminant and evolve independently, so a reader that had only the rejection would have to guess
 * its origin from the reason names - and a later query reason that happened to share a name with a
 * tag reason would then route a query mistake through the tag sentence, with nothing to catch it.
 * The function that picks one already knows which it picked; this is it saying so.
 */
export type SearchRejection =
  | { readonly source: 'query'; readonly rejection: SearchQueryRejection }
  | { readonly source: 'tags'; readonly rejection: TagsRejection };

/** What the query observed, plus what was refused before a request was ever made. */
export interface SearchObservation {
  /** Trimmed. Empty means nothing has been asked. */
  readonly query: string;
  readonly queryRejection: SearchQueryRejection | undefined;
  /** From `inspectTagsInput` over the tag chips. */
  readonly tagsRejection: TagsRejection | undefined;
  /** The last read failed with `node_not_found` on `scopes`: the container searched in is gone. */
  readonly scopeGone: boolean;
  /** The pages of the last successful reading, in request order, if any. */
  readonly pages: readonly SearchPage[] | undefined;
  readonly isPending: boolean;
  /** The most recent read failed, whether or not an earlier one succeeded. */
  readonly isError: boolean;
  readonly isFetchingNextPage: boolean;
  /** The most recent read was a next page, and it failed. The pages before it stand. */
  readonly isFetchNextPageError: boolean;
}

export interface SearchView {
  /** Nothing is being searched: the query is empty, or a phrase is still open. */
  readonly isIdle: boolean;
  /** Set: nothing was sent, and this is what to fix, and which field it is about. */
  readonly invalid: SearchRejection | undefined;
  /** The scope no longer exists. The search was not widened to cover for it. */
  readonly isScopeGone: boolean;
  /** Nothing has arrived and nothing has failed. */
  readonly isLoading: boolean;
  /** Nothing arrived and the read failed. There are no results, so the line stands alone. */
  readonly isUnavailable: boolean;
  /**
   * Pages are on screen from an earlier reading and a later read of them failed. Not a failed next
   * page: that one says so at the end of the list instead.
   */
  readonly isStale: boolean;
  /** The server answered, nothing matched, and it has nothing more to send. */
  readonly isEmpty: boolean;
  /** The next page is being read. */
  readonly isLoadingMore: boolean;
  /** The next page failed. Every row read so far stays; the list has not ended. */
  readonly isMoreError: boolean;
  /** The server has more after the last page. The list has not ended. */
  readonly hasMore: boolean;
  /**
   * The server says an archived node matched and was left out, so turning "Include archived" on would
   * add results. From the newest page; never true when archived nodes were included.
   */
  readonly archivedLeftOut: boolean;
  /** Every page's rows, in the server's order, each node once. */
  readonly items: readonly SearchResultItem[];
}

const nothing = (over: Partial<SearchView>): SearchView => ({
  isIdle: false,
  invalid: undefined,
  isScopeGone: false,
  isLoading: false,
  isUnavailable: false,
  isStale: false,
  isEmpty: false,
  isLoadingMore: false,
  isMoreError: false,
  hasMore: false,
  archivedLeftOut: false,
  items: [],
  ...over,
});

export const deriveSearchView = (observation: SearchObservation): SearchView => {
  // An opening quote is what a phrase looks like from the moment it is typed until it is closed. An
  // error line for the whole of that time would be noise about a query nobody has finished writing,
  // so it is idle - not searching yet - rather than invalid.
  if (observation.query === '' || observation.queryRejection?.reason === 'unterminated_phrase') {
    return nothing({ isIdle: true });
  }

  if (observation.queryRejection !== undefined) {
    return nothing({ invalid: { source: 'query', rejection: observation.queryRejection } });
  }

  if (observation.tagsRejection !== undefined) {
    return nothing({ invalid: { source: 'tags', rejection: observation.tagsRejection } });
  }

  // Ahead of the read states: the request did fail, but "the place you were searching is gone" is a
  // more specific and more actionable answer than "search did not answer", and the retry the latter
  // offers cannot succeed.
  if (observation.scopeGone) return nothing({ isScopeGone: true });

  const pages = observation.pages;
  const newest = pages?.at(-1);

  if (pages === undefined || newest === undefined) {
    return nothing({ isLoading: observation.isPending, isUnavailable: observation.isError });
  }

  const items = flattenSearchPages(pages);

  return nothing({
    isStale: observation.isError && !observation.isFetchNextPageError,
    // Also requires that nothing more is coming. A page whose every hit was a kind this build cannot
    // draw would map to no rows while the server still had more; that cannot happen today, since
    // notes are the only resource kind and they are drawn.
    isEmpty: items.length === 0 && !newest.hasMore,
    isLoadingMore: observation.isFetchingNextPage,
    isMoreError: observation.isFetchNextPageError,
    hasMore: newest.hasMore,
    // It describes the whole match set, so every page says the same; the newest is the latest word.
    archivedLeftOut: newest.archivedLeftOut,
    items,
  });
};
