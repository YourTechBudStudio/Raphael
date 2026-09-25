/**
 * How this app asks the server to search, and how the answer is keyed and grouped.
 *
 * The mirror of `resources/client/requests.ts`: the request is pinned field by field, the key
 * carries everything that changes the answer, and the order of the hits inside each group is the
 * server's. The screen sends one request and never a second - `skip` is always 0 and `limit` is
 * always `SEARCH_LIMIT` - so there is no page sequence here and nothing that walks one.
 *
 * **A search result is a point-in-time reading, not a maintained cache.** The query that uses these
 * builders sets `staleTime: 0` and `gcTime: 0`, and nothing in the app invalidates `SEARCH_SEGMENT`
 * on a write. Nothing needs to while search lives where it does: the screen is a modal, every write
 * surface is reached only by dismissing it, and the page is dropped the moment the screen unmounts,
 * so reopening search always asks the server again. A later capability that shows search results
 * outside the modal - beside a feed someone can write to - must add that invalidation itself;
 * `invalidateResources` is the notes-only function its own comment describes and must stay so.
 *
 * `groupSearchResults` is the one place the page is rearranged, and it is a partition, not a sort:
 * a hit's position relative to the other hits of its own kind is untouched. The "no reordering"
 * rule in `resources/client/requests.ts` protects a *paged* feed's continuity across requests;
 * a single page has none to protect, and the grouping is presentation over one complete answer.
 */

import { search } from '@raphael/client/nodes';
import type {
  NodeFilterInput,
  SearchHit,
  SearchRequestInput,
  ScopeSelector,
} from '@raphael/contracts/nodes';
import { CONTAINER_TYPES, ROOT_PATH } from '@raphael/contracts/nodes';

import type { Transport } from '../../../infrastructure/api';
import type { ContainerRef, ContainerType } from '../../../infrastructure/api/contracts';
import { unwrap } from '../../../infrastructure/query/failure.ts';
import { scopeKey } from '../../../infrastructure/query/keys.ts';
import { toNoteSummaryItem, type NoteSummaryItem } from '../../resources/summary.ts';

/** The cache segment every search lives under. Notes and media have their own. */
export const SEARCH_SEGMENT = 'search';

/**
 * One page, and the only page. Mobile does not page; a fuller answer is a narrower search.
 *
 * A modal that fills from the top has no good place to append, so reaching the end and pulling
 * would bring results in above rather than below. When the server says there are more, the screen
 * says the cap out loud instead of ending a list that quietly stopped being the whole answer.
 */
export const SEARCH_LIMIT = 100;

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

/** The wire request. One scope, recursive, one query, one page, from the top. */
export const searchRequest = (descriptor: SearchDescriptor): SearchRequestInput => {
  const filter = searchFilter(descriptor);

  return {
    scopes: [scopeSelector(descriptor.scope)],
    recursive: true,
    queries: [descriptor.query],
    ...(filter === undefined ? {} : { filter }),
    ...(descriptor.includeArchived ? { includeArchived: true } : {}),
    skip: 0,
    limit: SEARCH_LIMIT,
  };
};

/**
 * The cache key for one search.
 *
 * Every descriptor field is in it, because every one of them changes what comes back. The scope is
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

/** One hit as this app draws it: a container tile, or a note card. */
export type SearchResultItem =
  | {
      readonly kind: 'container';
      readonly ref: ContainerRef;
      readonly title: string;
      readonly description: string;
      /** Effectively archived. Search draws the pill for it. */
      readonly archived: boolean;
    }
  | { readonly kind: 'note'; readonly note: NoteSummaryItem };

const isContainerType = (value: string): value is ContainerType =>
  (CONTAINER_TYPES as readonly string[]).includes(value);

/**
 * A hit as something drawable, or null for a hit that is neither a container nor a note.
 *
 * Dropped rather than refused, which is the same judgment `toNoteSummaryItem` already makes: one
 * unrecognized row in a page of a hundred is a row to leave out, not a reason to tell someone their
 * search failed. A resource kind this build has never heard of has no honest card.
 */
export const toSearchResultItem = (hit: SearchHit): SearchResultItem | null => {
  const summary = hit.node;

  if (isContainerType(summary.type)) {
    return {
      kind: 'container',
      ref: { type: summary.type, id: summary.id },
      title: summary.title,
      description: summary.description,
      archived: summary.archived,
    };
  }

  const note = toNoteSummaryItem(summary);

  return note === null ? null : { kind: 'note', note };
};

/** One page of results as this app holds it: mapped, guarded, and carrying the server's own cap. */
export interface SearchPage {
  readonly items: readonly SearchResultItem[];
  /** The server has more than it sent. Never a claim about coverage; only about this sequence. */
  readonly hasMore: boolean;
  /**
   * An archived node matched and was left out. Always false when archived nodes were included. What
   * the left-out line is shown on, so pressing its button always adds results.
   */
  readonly archivedLeftOut: boolean;
}

/** Asks the server once. */
export const fetchSearchPage = async (
  transport: Transport,
  descriptor: SearchDescriptor,
  signal: AbortSignal,
): Promise<SearchPage> => {
  const response = unwrap(await search(transport, searchRequest(descriptor), signal));

  return {
    items: response.items
      .map((hit) => toSearchResultItem(hit))
      .filter((item): item is SearchResultItem => item !== null),
    hasMore: response.hasMore,
    archivedLeftOut: response.archivedLeftOut,
  };
};

export type ContainerResultItem = Extract<SearchResultItem, { kind: 'container' }>;

export interface SearchGroups {
  readonly areas: readonly ContainerResultItem[];
  readonly projects: readonly ContainerResultItem[];
  readonly notes: readonly NoteSummaryItem[];
}

export const EMPTY_GROUPS: SearchGroups = { areas: [], projects: [], notes: [] };

/**
 * The page, partitioned into the three sections the screen draws.
 *
 * A partition and never a sort. Relevance is the server's answer and the only ordering anyone here
 * can defend; what this decides is which heading a hit sits under, not where it sits beneath it.
 */
export const groupSearchResults = (items: readonly SearchResultItem[]): SearchGroups => {
  const areas: ContainerResultItem[] = [];
  const projects: ContainerResultItem[] = [];
  const notes: NoteSummaryItem[] = [];

  // Named per type rather than "area, else project", so a third container type in the contract
  // arrives as a compile error - the switch would no longer return on every path - instead of
  // quietly filing itself under Projects. The same discipline `toSearchResultItem` keeps: draw a
  // hit honestly, or do not draw it.
  const sectionFor = (type: ContainerType): ContainerResultItem[] => {
    switch (type) {
      case 'area':
        return areas;
      case 'project':
        return projects;
    }
  };

  for (const item of items) {
    if (item.kind === 'note') {
      notes.push(item.note);
      continue;
    }

    sectionFor(item.ref.type).push(item);
  }

  return { areas, projects, notes };
};
