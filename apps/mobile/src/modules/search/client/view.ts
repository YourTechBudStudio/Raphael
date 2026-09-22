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
 * refused before it left - reports no results rather than no matches. And a full page is never the
 * whole answer: `isCapped` carries the server's own `hasMore` to the screen so the cap can be said
 * out loud.
 *
 * The five page-derived flags are the first five of `deriveNoteFeed`'s, restated rather than shared.
 * Those distinctions are about a paged sequence - a failed next page, a walk that can continue - and
 * this screen has no second page to have them about. Sharing would drag next-page semantics into a
 * screen with none; the cost is five lines that must agree in meaning, not in code.
 */

import type { SearchQueryRejection, TagsRejection } from '@raphael/contracts/nodes';

import { asClientFailure } from '../../../infrastructure/query/failure.ts';
import {
  EMPTY_GROUPS,
  groupSearchResults,
  type SearchGroups,
  type SearchPage,
} from './requests.ts';

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
  /** The last successful reading, if any. */
  readonly page: SearchPage | undefined;
  readonly isPending: boolean;
  /** The most recent read failed, whether or not an earlier one succeeded. */
  readonly isError: boolean;
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
  /** Results are on screen from an earlier reading and a later read of the same search failed. */
  readonly isStale: boolean;
  /** The server answered, and nothing matched. */
  readonly isEmpty: boolean;
  /** The page is full and the server has more. What is shown is a prefix, and says so. */
  readonly isCapped: boolean;
  readonly groups: SearchGroups;
}

const nothing = (over: Partial<SearchView>): SearchView => ({
  isIdle: false,
  invalid: undefined,
  isScopeGone: false,
  isLoading: false,
  isUnavailable: false,
  isStale: false,
  isEmpty: false,
  isCapped: false,
  groups: EMPTY_GROUPS,
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

  const page = observation.page;

  if (page === undefined) {
    return nothing({ isLoading: observation.isPending, isUnavailable: observation.isError });
  }

  return nothing({
    isStale: observation.isError,
    isEmpty: page.items.length === 0,
    isCapped: page.hasMore,
    groups: groupSearchResults(page.items),
  });
};
