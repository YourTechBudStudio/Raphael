/**
 * Search, as one question asked of the server.
 *
 * The server decides what matches and in what order; this asks it, a page at a time, and walks
 * further only as someone scrolls to the end of what has arrived. There is no client-side notion of
 * what matching means, and nothing here reorders what the server ranked.
 *
 * Two rules it keeps, both borrowed from the notes capability because they are the same rules.
 * Every key is stamped with the connection activation, and the query function captures the session's
 * transport at render rather than reading the current one when it runs - so a search issued against
 * one server stays a search against that server, and lands in a key nothing is looking at if the
 * connection changed underneath it.
 *
 * **A malformed query and a malformed tag never leave the phone.** Both are inspected here through
 * the contract's own inspectors, and `enabled` is false while either is set. This is not politeness
 * about round trips: `run` in the client package would refuse a repeated, empty, over-long or
 * over-counted tag as an `invalid_request`, `unwrap` would throw it, and the view would read the
 * throw as "search did not answer" - which is the wrong sentence, and an unrecoverable one, for a
 * typo in a tag. The inspectors are the same authority the decoder is built from, so the local
 * verdict and the server's cannot disagree.
 */

import { inspectQueryInput, inspectTagsInput } from '@raphael/contracts/nodes';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useConnectionSession } from '../../connection';
import { requestMoreResults, retryMoreResults, searchPagesOptions } from './options.ts';
import type { SearchDescriptor } from './requests.ts';
import { deriveSearchView, isScopeGone, type SearchView } from './view.ts';

export interface SearchResults {
  readonly view: SearchView;
  /** Ask the same question again, over every page held. The retry when nothing arrived. */
  readonly refresh: () => void;
  readonly isRefreshing: boolean;
  /** The end of the list is on screen: ask for the next page, if asking is right. */
  readonly loadMore: () => void;
  /** Ask again for the next page that failed. */
  readonly retryMore: () => void;
}

export function useSearchResults(descriptor: SearchDescriptor): SearchResults {
  const session = useConnectionSession();
  const activation = session?.activation ?? -1;
  const transport = session?.transport ?? null;

  const { query, tags } = descriptor;

  // An empty query is not an invalid one - it is a search nobody has asked for yet - so it is never
  // put to the inspector, whose answer for it would be a complaint about nothing.
  const queryRejection = useMemo(
    () => (query === '' ? undefined : inspectQueryInput(query)),
    [query],
  );
  const tagsRejection = useMemo(() => inspectTagsInput(tags), [tags]);

  const enabled = query !== '' && queryRejection === undefined && tagsRejection === undefined;

  const result = useInfiniteQuery(searchPagesOptions(activation, transport, descriptor, enabled));

  const view = deriveSearchView({
    query,
    queryRejection,
    tagsRejection,
    scopeGone: isScopeGone(result.error),
    pages: result.data?.pages,
    isPending: result.isPending,
    isError: result.isError,
    isFetchingNextPage: result.isFetchingNextPage,
    isFetchNextPageError: result.isFetchNextPageError,
  });

  return {
    view,
    refresh: () => {
      void result.refetch();
    },
    isRefreshing: result.isRefetching,
    loadMore: () => {
      requestMoreResults(result);
    },
    retryMore: () => {
      retryMoreResults(result);
    },
  };
}
