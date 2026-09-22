/**
 * How this app asks the server for notes, and how the answers are keyed.
 *
 * Everything here is pure and private to the capability. One builder makes the List request, one
 * makes the cache key, and they take the same descriptor - so a query that asks a different question
 * cannot share a cache entry with one that asks this question, which is the failure a hand-written
 * key invites. The key carries the scope selector, the recursion, the filter this capability always
 * applies, the ordering *in the caller's priority order*, the starting offset and the page size,
 * because every one of those changes what came back.
 *
 * What is deliberately absent: any reordering, any tie-breaker, any client-side notion of recency.
 * Core appends the id clause that makes an ordering total (`effectiveOrderBy` in the backend's list
 * module), and a page arrives in the sequence the database produced. Re-deriving that here would be
 * a second authority on ordering that could disagree with the first, and `updatedAt` is not even a
 * field a response carries, so there would be nothing honest to sort by.
 */

import { list } from '@raphael/client/nodes';
import type { NodeOrderBy, NodeSummary, ScopeSelector } from '@raphael/contracts/nodes';
import { LIST_LIMIT_DEFAULT, ROOT_PATH } from '@raphael/contracts/nodes';
import type { ListRequestInput } from '@raphael/contracts/nodes';

import type { Transport } from '../../../infrastructure/api';
import { unwrap } from '../../../infrastructure/query/failure.ts';
import { scopeKey } from '../../../infrastructure/query/keys.ts';
import { toNoteSummaryItem, type NoteSummaryItem } from './summary.ts';

/** The cache segment every server-note query lives under. Media has its own. */
export const NOTES_SEGMENT = 'notes';
/**
 * One page, everywhere. The server's own default, which is what a client with no better information
 * should ask for: it is the size core is tuned against, and a smaller page would multiply round
 * trips for a feed people scroll.
 */
export const NOTE_PAGE_SIZE = LIST_LIMIT_DEFAULT;

/** Home's ordering. Core appends the id tie-breaker; this must not name one itself. */
export const NEWEST_FIRST: NodeOrderBy = [{ field: 'updatedAt', direction: 'desc' }];

/** Every note on the server, wherever it sits. */
export const ROOT_SCOPE: ScopeSelector = { path: ROOT_PATH };

/** The one node type this capability ever asks for. */
const RESOURCE_FILTER = 'resource';

/**
 * Everything that makes one page of notes the page it is.
 *
 * There is no type field. Every page this capability reads is a page of resources, so a descriptor
 * field would be one more spelling of a decision `noteListRequest` already makes - and a caller
 * holding a descriptor could then ask this feed for something that is not a note.
 */
export interface NoteListDescriptor {
  readonly parent: ScopeSelector;
  readonly recursive: boolean;
  /** Null means the server's default order - slug then id - and is not the same key as any ordering. */
  readonly orderBy: NodeOrderBy | null;
  readonly skip: number;
  readonly limit: number;
}

/** The descriptor for Home's feed at a given offset. */
export const feedDescriptor = (skip: number): NoteListDescriptor => ({
  parent: ROOT_SCOPE,
  recursive: true,
  orderBy: NEWEST_FIRST,
  skip,
  limit: NOTE_PAGE_SIZE,
});

/**
 * The descriptor for one container's notes at a given offset.
 *
 * Not recursive, and in the server's default order. A project's notes are the notes filed in it, not
 * everything underneath it, and a container list has no recency to offer - ordering it by update
 * time would make the page sequence depend on edits happening elsewhere.
 */
export const containerDescriptor = (parentId: number, skip: number): NoteListDescriptor => ({
  parent: { id: parentId },
  recursive: false,
  orderBy: null,
  skip,
  limit: NOTE_PAGE_SIZE,
});

/**
 * The wire request. `orderBy` is omitted entirely when null, which is how the default is asked for.
 *
 * One scope, because a note feed looks in one place. The filter is written out rather than taken
 * from the descriptor: notes are the only resource kind core admits today, and the guard on the way
 * back is what proves the answer kept its side of that.
 */
export const noteListRequest = (descriptor: NoteListDescriptor): ListRequestInput => ({
  scopes: [descriptor.parent],
  recursive: descriptor.recursive,
  filter: { type: RESOURCE_FILTER },
  ...(descriptor.orderBy === null
    ? {}
    : { orderBy: descriptor.orderBy.map((clause) => ({ ...clause })) }),
  skip: descriptor.skip,
  limit: descriptor.limit,
});

/**
 * The cache key for a traversal.
 *
 * `skip` here is where the traversal *starts*, not where it currently is: later pages are page
 * parameters within this one cached traversal, so two screens paging the same list share its pages
 * rather than racing each other for them.
 */
export const noteListKey = (
  activation: number,
  descriptor: NoteListDescriptor,
): readonly unknown[] =>
  scopeKey(
    activation,
    NOTES_SEGMENT,
    descriptor.parent,
    descriptor.recursive,
    // A constant, and named anyway: the key says what was asked for, so a later feed that asks a
    // different question cannot land on an answer read under this one.
    RESOURCE_FILTER,
    descriptor.orderBy === null ? null : descriptor.orderBy.map((clause) => ({ ...clause })),
    descriptor.skip,
    descriptor.limit,
  );

/** One page of notes as this app holds it: mapped, guarded, and carrying the server's own offsets. */
export interface NotePage {
  readonly items: readonly NoteSummaryItem[];
  readonly skip: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * Where the next page starts, or null when there is none.
 *
 * Read from what the server said about the page it just sent, never from how many cards survived the
 * kind guard or reached the screen. A dropped summary still occupied an offset, so counting visible
 * cards would walk the traversal backwards over rows it had already been given.
 */
export const nextPageSkip = (page: NotePage): number | null =>
  page.hasMore ? page.skip + page.limit : null;

/**
 * Asks for one page.
 *
 * Anything that is not a note is dropped rather than rendered: `filter: { type: 'resource' }` is a
 * filter on the request, and a server that later serves another resource kind would otherwise have
 * it land in a notes grid drawn as a note.
 */
export const fetchNotePage = async (
  transport: Transport,
  descriptor: NoteListDescriptor,
  signal: AbortSignal,
): Promise<NotePage> => {
  const response = unwrap(await list(transport, noteListRequest(descriptor), signal));

  return {
    items: response.items
      .map((summary: NodeSummary) => toNoteSummaryItem(summary))
      .filter((item): item is NoteSummaryItem => item !== null),
    skip: response.skip,
    limit: response.limit,
    hasMore: response.hasMore,
  };
};
