/**
 * Notes, read from the connected Raphael.
 *
 * Three reads. Two of them are paged traversals - Home's newest-first
 * list of everything, and one container's own notes - and they are the *same* traversal machinery
 * with different descriptors, so paging, transport capture, mapping, failure and refresh behave
 * identically wherever notes appear. The third is one note's entity, which is the only read that
 * carries a body.
 *
 * Two rules this file exists to keep:
 *
 * Every key is stamped with the connection activation and every query function captures the
 * session's transport at render rather than reading the current one when it runs. A read issued
 * against one server stays a read against that server, and lands in a key nothing is looking at if
 * the connection changed underneath it.
 *
 * No screen downloads a body to draw a card. The list response carries the title and description a
 * card shows; the body is fetched exactly once, when someone opens the note.
 *
 * Every request and key lives in `options.ts` rather than inline here, so what this capability
 * promises about offsets, guards, restarts and formats can be driven against the real query library,
 * and against a real server, without a renderer standing in the way.
 */

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { useConnectionSession } from '../../connection';
import type { NoteEntity } from './entity.ts';
import { deriveNoteFeed, type NoteFeedView } from './feed-state.ts';
import {
  noteEntityOptions,
  notePagesOptions,
  requestNextPage,
  truncateToFirstPage,
} from './options.ts';
import {
  containerDescriptor,
  feedDescriptor,
  noteListKey,
  type NoteListDescriptor,
} from './requests.ts';

/** What a screen holds: the six-way state, and the two things a person can ask for. */
export interface NoteFeed {
  readonly view: NoteFeedView;
  /** Called when the scroll nears the end. Safe to call repeatedly; it guards itself. */
  readonly loadMore: () => void;
  /** Pull-to-refresh: drop every page after the first and read page one again. */
  readonly refresh: () => void;
  readonly isRefreshing: boolean;
}

const usePagedNotes = (
  descriptorAt: (skip: number) => NoteListDescriptor,
  enabled: boolean,
): NoteFeed => {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;

  const query = useInfiniteQuery(
    notePagesOptions(activation, session?.transport ?? null, descriptorAt, enabled),
  );

  const { fetchNextPage, refetch, hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;

  const loadMore = useCallback(() => {
    requestNextPage({ hasNextPage, isFetchingNextPage, fetchNextPage }, isFetchNextPageError);
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError]);

  const refresh = useCallback(() => {
    truncateToFirstPage(client, noteListKey(activation, descriptorAt(0)));
    void refetch();
  }, [client, activation, descriptorAt, refetch]);

  const view = deriveNoteFeed({
    pages: query.data?.pages,
    isPending: query.isPending,
    isError: query.isError,
    isFetchNextPageError: query.isFetchNextPageError,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
  });

  return { view, loadMore, refresh, isRefreshing: query.isRefetching };
};

/** Home's feed: every note on the server, newest server edit first. */
export function useNoteFeed(): NoteFeed {
  return usePagedNotes(feedDescriptor, true);
}

/** One container's own notes, in the server's default order. */
export function useNotePages(parent: ContainerRef | null): NoteFeed {
  const parentId = parent?.id ?? 0;

  return usePagedNotes(
    useCallback((skip: number) => containerDescriptor(parentId, skip), [parentId]),
    parent !== null,
  );
}

/** One note, with its body. What it asks for, and of which server, is `options.ts`. */
export function useResource(id: number | null): UseQueryResult<NoteEntity> {
  const session = useConnectionSession();

  return useQuery(noteEntityOptions(session?.activation ?? -1, session?.transport ?? null, id));
}
