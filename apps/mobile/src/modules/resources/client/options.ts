/**
 * Every note read this capability performs, as data.
 *
 * Separated from the hooks deliberately, and the separation earns its place twice over. What this
 * capability promises about offsets, guards, restarts and formats is a promise about the requests
 * that actually go out and about how the query library behaves under them - and none of that can be
 * shown by inspecting an options object. Here they are plain functions a test can drive against a
 * real client and a real server with no renderer and no connection store in the way.
 *
 * Nothing here reads the current connection. Each builder takes the transport it is to use, which is
 * what makes a read issued under one activation stay a read under that activation however long it
 * takes to come back.
 *
 * Private to the capability: the public interface publishes the hooks, not the keys they are built
 * from.
 */

import { infiniteQueryOptions, type InfiniteData, type QueryClient } from '@tanstack/react-query';

import type { Transport } from '../../../infrastructure/api';
import {
  fetchNotePage,
  nextPageSkip,
  noteListKey,
  type NoteListDescriptor,
  type NotePage,
} from './requests.ts';

/**
 * Everything a paged note traversal is.
 *
 * `transport` is the one the session held when this was built, not one read later. That is the whole
 * fencing story in one parameter: a traversal cannot be retargeted at a different server halfway
 * through, because there is nowhere for it to look up a newer one.
 */
export const notePagesOptions = (
  activation: number,
  transport: Transport | null,
  descriptorAt: (skip: number) => NoteListDescriptor,
  enabled: boolean,
) =>
  infiniteQueryOptions({
    queryKey: noteListKey(activation, descriptorAt(0)),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }): Promise<NotePage> => {
      if (transport === null) throw new Error('No connection');

      return fetchNotePage(transport, descriptorAt(pageParam), signal);
    },
    // From what the server said about the page it sent, never from how many cards survived the kind
    // guard or reached the screen. A dropped summary still occupied an offset.
    getNextPageParam: (lastPage: NotePage) => nextPageSkip(lastPage) ?? undefined,
    enabled: transport !== null && enabled,
  });

/**
 * Drops every page after the first, so the next read is a fresh traversal rather than a repair.
 *
 * Offsets are not a snapshot. Page three of a list that has changed describes different rows than it
 * did, so refetching every held page and reassembling them would splice readings taken at different
 * moments into one list and present the result as current.
 *
 * It runs before the request rather than after the answer, so the cards already on screen stay put
 * while the read happens: a refresh that fails leaves a true earlier reading of page one and a line
 * saying what is not known, instead of an empty screen.
 */
export const truncateToFirstPage = (client: QueryClient, key: readonly unknown[]): void => {
  client.setQueryData<InfiniteData<NotePage, number>>(key, (current) =>
    current === undefined || current.pages.length <= 1
      ? current
      : { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) },
  );
};

/** The part of an infinite-query result the end-of-scroll guard actually consults. */
export interface NextPageGate {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
}

/**
 * Asks for the next page, if asking is the right thing to do.
 *
 * The guard is load-bearing rather than belt-and-braces: the query library does **not** collapse two
 * overlapping `fetchNextPage` calls into one, and a scroll listener fires on every qualifying scroll
 * event. Without this, one flick queues several requests for the same offset and the pages they
 * return are appended twice.
 *
 * It also stops at a failed page. Scrolling into a refused request repeatedly would spend requests
 * on a server that has already said no; the retry is the person's pull-down.
 *
 * Returns whether a request was made, which is what makes the guard testable.
 */
export const requestNextPage = (query: NextPageGate, previousPageFailed = false): boolean => {
  if (!query.hasNextPage || query.isFetchingNextPage || previousPageFailed) return false;

  void query.fetchNextPage();

  return true;
};
