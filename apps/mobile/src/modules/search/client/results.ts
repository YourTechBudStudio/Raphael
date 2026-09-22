/**
 * Search, as one question asked of the server.
 *
 * The screen filtered a hierarchy it held in memory and said so about notes, because there was no
 * server search to ask. There is now, so this asks it: one request, one page, and no client-side
 * notion of what matching means. Notes are searched for the first time, and by their body text as
 * well as their title and description, which is something no client could have done for itself.
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
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useConnectionSession } from '../../connection';
import { fetchSearchPage, searchKey, type SearchDescriptor, type SearchPage } from './requests.ts';
import { deriveSearchView, isScopeGone, type SearchView } from './view.ts';

export interface SearchResults {
  readonly view: SearchView;
  /** Ask the same question again. There is no next page to ask for. */
  readonly refresh: () => void;
  readonly isRefreshing: boolean;
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

  const enabled =
    transport !== null &&
    query !== '' &&
    queryRejection === undefined &&
    tagsRejection === undefined;

  const result = useQuery({
    queryKey: searchKey(activation, descriptor),
    queryFn: ({ signal }): Promise<SearchPage> => {
      if (transport === null) throw new Error('No connection');

      return fetchSearchPage(transport, descriptor, signal);
    },
    // A reading of this moment, never a cached one. Nothing invalidates `SEARCH_SEGMENT` on a write
    // and nothing needs to: with no freshness and no retention, the page is dropped when the modal
    // closes and reopening asks the server again. See `requests.ts`.
    staleTime: 0,
    gcTime: 0,
    enabled,
  });

  const view = deriveSearchView({
    query,
    queryRejection,
    tagsRejection,
    scopeGone: isScopeGone(result.error),
    page: result.data,
    isPending: result.isPending,
    isError: result.isError,
  });

  return {
    view,
    refresh: () => {
      void result.refetch();
    },
    isRefreshing: result.isRefetching,
  };
}
