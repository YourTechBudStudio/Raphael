/**
 * How this app asks the server to search, and how the answer is keyed and paged.
 *
 * The mirror of `resources/client/requests.ts`: the request is pinned field by field, the key
 * carries everything that changes the answer, and the order of the hits is the server's. The answer
 * is a page sequence walked on scroll: each page asks from where the server said the last one
 * ended, and `flattenSearchPages` joins the pages into the one list the screen draws, without
 * reordering anything.
 *
 * **A search result is a point-in-time reading, not a maintained cache.** The query that uses these
 * builders sets `staleTime: 0` and `gcTime: 0`, and nothing in the app invalidates `SEARCH_SEGMENT`
 * on a write. Nothing needs to while search lives where it does: the screen is a modal, every write
 * surface is reached only by dismissing it, and the pages are dropped the moment the screen
 * unmounts, so reopening search always asks the server again. A later capability that shows search
 * results outside the modal - beside a feed someone can write to - must add that invalidation
 * itself; `invalidateResources` is the notes-only function its own comment describes and must stay
 * so.
 */

import { search } from '@raphael/client/nodes';
import type {
  NodeFilterInput,
  SearchHit,
  SearchRequestInput,
  ScopeSelector,
} from '@raphael/contracts/nodes';
import { CONTAINER_TYPES, LIST_LIMIT_DEFAULT, ROOT_PATH } from '@raphael/contracts/nodes';

import type { Transport } from '../../../infrastructure/api';
import type { ContainerRef, ContainerType } from '../../../infrastructure/api/contracts';
import { unwrap } from '../../../infrastructure/query/failure.ts';
import { scopeKey } from '../../../infrastructure/query/keys.ts';
import { toNoteSummaryItem } from '../../resources/summary.ts';

/** The cache segment every search lives under. Notes and media have their own. */
export const SEARCH_SEGMENT = 'search';

/**
 * How many hits one page asks for: the contract's default page, the same size every list uses.
 *
 * Small enough that the first rows arrive quickly, large enough that one page always fills the
 * screen, so the end is only reached by scrolling to it.
 */
export const SEARCH_PAGE_LIMIT = LIST_LIMIT_DEFAULT;

/** What the "Show" chips choose between. `'note'` is the one leaf kind core admits. */
export type SearchTypeFilter = 'all' | 'area' | 'project' | 'note';

/** Everything that makes one search the search it is. */
export interface SearchDescriptor {
  /** The container the search is limited to. Null means the whole server. */
  readonly scope: ContainerRef | null;
  /** Already trimmed. A request is only built for a non-empty query. */
  readonly query: string;
  readonly type: SearchTypeFilter;
  /**
   * Normalized with `normalizeTag` and already accepted by `inspectTagsInput`. Empty means no tag
   * predicate at all, which is not the same request as asking for any one tag.
   */
  readonly tags: readonly string[];
  /** Archived nodes are part of the answer. Off by default: Search is how archived things come back. */
  readonly includeArchived: boolean;
}

/** Where to look: the chosen container, or the root. */
const scopeSelector = (scope: ContainerRef | null): ScopeSelector =>
  scope === null ? { path: ROOT_PATH } : { id: scope.id };

/**
 * The filter the chips and the tag list add up to, or nothing to say.
 *
 * `undefined` rather than an empty object, because an omitted filter and a filter that restricts
 * nothing are the same question and only one of them should ever be sent.
 */
export const searchFilter = (descriptor: SearchDescriptor): NodeFilterInput | undefined => {
  const type =
    descriptor.type === 'all'
      ? {}
      : descriptor.type === 'note'
        ? // A note is a resource of one kind. The chip says "Notes" because that is the only kind
          // there is; naming both is what keeps a later resource kind out of this answer.
          ({ type: 'resource', kind: 'note' } as const)
        : ({ type: descriptor.type } as const);
  const tags = descriptor.tags.length === 0 ? {} : { tags: { $in: [...descriptor.tags] } };
  const filter = { ...type, ...tags };

  return Object.keys(filter).length === 0 ? undefined : filter;
};

/** The wire request. One scope, recursive, one query, one page, from `skip`. */
export const searchRequest = (descriptor: SearchDescriptor, skip: number): SearchRequestInput => {
  const filter = searchFilter(descriptor);

  return {
    scopes: [scopeSelector(descriptor.scope)],
    recursive: true,
    queries: [descriptor.query],
    ...(filter === undefined ? {} : { filter }),
    ...(descriptor.includeArchived ? { includeArchived: true } : {}),
    skip,
    limit: SEARCH_PAGE_LIMIT,
  };
};

/**
 * The cache key for one search, and for every page of it.
 *
 * Every descriptor field is in it, because every one of them changes what comes back. The offset is
 * not: the pages of one search live together under one key, as one sequence. The scope is
 * keyed as the selector that is actually sent, so a search of the root and a search of a container
 * cannot read one another's answer.
 */
export const searchKey = (activation: number, descriptor: SearchDescriptor): readonly unknown[] =>
  scopeKey(
    activation,
    SEARCH_SEGMENT,
    scopeSelector(descriptor.scope),
    descriptor.query,
    descriptor.type,
    [...descriptor.tags],
    descriptor.includeArchived,
  );

/** One hit as this app draws it: a row with a kind, a title, and the container it lives in. */
export interface SearchResultItem {
  readonly id: number;
  /** `'note'` is a resource of kind note, the one resource kind this build can draw. */
  readonly type: ContainerType | 'note';
  readonly title: string;
  /** The container it lives in. Null only for a top-level area. */
  readonly parentId: number | null;
  /** Effectively archived. Search draws the pill for it. */
  readonly archived: boolean;
}

const isContainerType = (value: string): value is ContainerType =>
  (CONTAINER_TYPES as readonly string[]).includes(value);

/**
 * A hit as something drawable, or null for a hit that is neither a container nor a note.
 *
 * Dropped rather than refused, which is the same judgment `toNoteSummaryItem` already makes: one
 * unrecognized row in a page is a row to leave out, not a reason to tell someone their search
 * failed. A resource kind this build has never heard of has no honest row.
 */
export const toSearchResultItem = (hit: SearchHit): SearchResultItem | null => {
  const summary = hit.node;
  const common = {
    id: summary.id,
    title: summary.title,
    parentId: summary.parentId,
    archived: summary.archived,
  };

  if (isContainerType(summary.type)) return { ...common, type: summary.type };

  return toNoteSummaryItem(summary) === null ? null : { ...common, type: 'note' };
};

/** One page of results as this app holds it: mapped, guarded, and carrying where it sits. */
export interface SearchPage {
  readonly items: readonly SearchResultItem[];
  /** The offset the server answered from, and the page size it used. The next page starts after. */
  readonly skip: number;
  readonly limit: number;
  /** The server has more than it sent. Never a claim about coverage; only about this sequence. */
  readonly hasMore: boolean;
  /**
   * An archived node matched and was left out. Always false when archived nodes were included. It
   * describes the whole match set, so every page of one search says the same.
   */
  readonly archivedLeftOut: boolean;
}

/** Asks the server for one page, from `skip`. */
export const fetchSearchPage = async (
  transport: Transport,
  descriptor: SearchDescriptor,
  skip: number,
  signal: AbortSignal,
): Promise<SearchPage> => {
  const response = unwrap(await search(transport, searchRequest(descriptor, skip), signal));

  return {
    items: response.items
      .map((hit) => toSearchResultItem(hit))
      .filter((item): item is SearchResultItem => item !== null),
    skip: response.skip,
    limit: response.limit,
    hasMore: response.hasMore,
    archivedLeftOut: response.archivedLeftOut,
  };
};

/**
 * The pages as one list, in page order, with each node once.
 *
 * Pages are not a snapshot. A node renamed or edited between two page requests can rank on both, so
 * the same id can arrive twice. The copy kept is the one from the most recently requested page,
 * at that page's position: it is the newer reading. Keeping one is also what React needs, since a row
 * is keyed by its node. Nothing is sorted; the order is still the server's.
 */
export const flattenSearchPages = (pages: readonly SearchPage[]): readonly SearchResultItem[] => {
  const items = pages.flatMap((page) => page.items);
  const lastIndex = new Map<number, number>();

  items.forEach((item, index) => {
    lastIndex.set(item.id, index);
  });

  return items.filter((item, index) => lastIndex.get(item.id) === index);
};
