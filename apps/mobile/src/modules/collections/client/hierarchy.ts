/**
 * Reading the whole container hierarchy, once, completely, or not at all.
 *
 * The server answers List in pages. This assembles them into a tree, and the rule it exists to
 * enforce is that a partial accumulation is never a hierarchy. Publishing one would be worse than
 * showing nothing: a Browse filter would report "no matches" for an area that simply had not
 * arrived yet, and an area screen would show a subset of its children as though that were all of
 * them. So the traversal either completes or throws, and there is no state in between that a
 * screen can accidentally render.
 *
 * Successive offset-based pages are **not a transactional snapshot**. If containers are created or
 * moved between two requests, page boundaries shift, and the pages can overlap or skip. This does
 * not pretend otherwise and does not repair it: a duplicate id, a child whose parent never arrived,
 * a project holding children, or a cycle all end the traversal as inconsistent rather than being
 * patched up with invented parentage. A retry starts over from the first page - old pages are never
 * spliced into a new traversal - because a fresh read is the only thing that can be internally
 * consistent.
 *
 * Everything arrives through the injected `list`, so pagination, cancellation, malformed responses,
 * and every structural refusal are exercised by tests with no server and no device.
 */

import type { ClientResult } from '@raphael/client';
import type {
  ContainerType,
  ListRequestInput,
  ListResponse,
  NodeSummary,
} from '@raphael/contracts/nodes';
import {
  CONTAINER_TYPES,
  LIST_LIMIT_MAX,
  ROOT_PATH,
  compareNodeOrder,
} from '@raphael/contracts/nodes';

import { unwrap } from '../../../infrastructure/query/failure.ts';

/**
 * Items per page. The contract's maximum, because this fetches everything anyway and a smaller page
 * only means more round trips.
 *
 * It is a page size and not a limit on how many containers a hierarchy may hold: as many pages are
 * asked for as it takes. The limit on how many this app will hold at once is `MAX_CONTAINERS`
 * below, which is a separate and much larger number, and is the one place this phase does impose a
 * total.
 */
export const PAGE_LIMIT = LIST_LIMIT_MAX;

/**
 * An absolute ceiling on one traversal.
 *
 * This is an operational safety bound, not a product limit, and it is the one place where that
 * distinction does not fully hold: a hierarchy genuinely larger than this is refused, not truncated.
 * The alternative is worse. A server that keeps answering with full pages and never sets `hasMore`
 * to false - a bug, a proxy, something that is not Raphael - would otherwise be read until the phone
 * ran out of memory, and the phase's own rule that nothing partial is ever published means there is
 * no smaller failure available part-way through.
 *
 * Chosen far above any hierarchy of areas and projects a person maintains by hand, so that reaching
 * it says something is wrong with the answers rather than with the hierarchy. It is named in the
 * failure, and recorded in the decision log as a deviation, because a bound nobody has been told
 * about is the kind that is discovered by hitting it.
 */
export const MAX_CONTAINERS = 20_000;

export interface HierarchyNode {
  readonly id: number;
  readonly type: ContainerType;
  readonly parentId: number | null;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly children: readonly HierarchyNode[];
}

export interface Hierarchy {
  /** Top-level areas, in the server's order. */
  readonly roots: readonly HierarchyNode[];
  readonly byId: ReadonlyMap<number, HierarchyNode>;
}

/**
 * The pages were read without incident and still do not describe a hierarchy this app can hold.
 *
 * Deliberately not a `ClientFailure`: nothing went wrong with any single request, and the retry
 * policy that governs transport failures does not apply. It is also deliberately not retried
 * automatically - a loop that keeps re-reading a hierarchy someone is actively editing would hide
 * the condition rather than resolve it.
 *
 * `retryable` is the part the screens need, and the reason this carries a flag rather than only a
 * message. Pages that contradict each other are a snapshot problem: a read taken a moment later is
 * very likely to be consistent, so a retry is the right thing to offer. A hierarchy larger than this
 * app will read is a settled fact about the server, and a Try again that cannot possibly succeed is
 * worse than saying plainly that it will not.
 */
export class HierarchyRefusedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'HierarchyRefusedError';
    this.retryable = retryable;
  }
}

export type ListFn = (
  request: ListRequestInput,
  signal?: AbortSignal,
) => Promise<ClientResult<ListResponse>>;

/** A runtime narrowing, not a cast: the server's answer is checked before it becomes a container. */
const isContainerType = (value: string): value is ContainerType =>
  (CONTAINER_TYPES as readonly string[]).includes(value);

const inconsistent = (message: string): never => {
  throw new HierarchyRefusedError(message, true);
};

const tooLarge = (message: string): never => {
  throw new HierarchyRefusedError(message, false);
};

/**
 * Every page, from the root, recursively.
 *
 * The progress checks are what stop a malformed answer from becoming an infinite loop. A page that
 * claims there is more and returns nothing would never advance `skip`; a page longer than the limit
 * it was given is not answering the question that was asked.
 */
const fetchPages = async (list: ListFn, signal?: AbortSignal): Promise<NodeSummary[]> => {
  const items: NodeSummary[] = [];
  let skip = 0;

  for (;;) {
    const request: ListRequestInput = {
      parent: { path: ROOT_PATH },
      recursive: true,
      // Asked for explicitly rather than left to the default. The server's default is now every node
      // type, which includes notes, and a hierarchy built from a list containing leaves would be a tree
      // this app cannot hold. Naming the filter is what keeps the widened vocabulary from reaching here.
      types: [...CONTAINER_TYPES],
      skip,
      limit: PAGE_LIMIT,
    };
    // `unwrap` throws the client failure, which ends the traversal without publishing what has been
    // collected so far. That is the whole point: there is no partial result to leak.
    const page = unwrap(await list(request, signal));

    if (page.items.length > PAGE_LIMIT) {
      return inconsistent('The server returned more results than the page it was asked for.');
    }

    if (page.items.length === 0 && page.hasMore) {
      return inconsistent('The server reported more results and returned none.');
    }

    items.push(...page.items);

    if (items.length > MAX_CONTAINERS) {
      return tooLarge(
        `This server holds more than ${String(MAX_CONTAINERS)} areas and projects, which is more than Raphael reads on a phone in one go.`,
      );
    }

    if (!page.hasMore) return items;

    skip += page.items.length;
  }
};

/**
 * A summary already checked to be a container.
 *
 * A distinct type rather than a comment, so the check in `assemble` is carried by the value rather than
 * remembered by the reader: everything downstream of it takes this, and nothing can reach `build` with
 * a row whose type was never examined.
 */
type ContainerSummary = Omit<NodeSummary, 'type'> & { readonly type: ContainerType };

interface Building {
  readonly summary: ContainerSummary;
  readonly children: ContainerSummary[];
}

/**
 * Pages into a tree, refusing anything that does not describe one.
 *
 * Each refusal names a real way offset pagination can go wrong while the hierarchy is being edited,
 * and none of them is repairable from here. An orphan could be attached to the root, a duplicate
 * could be ignored - and both would be this client inventing a hierarchy the server never
 * described, which is exactly the thing a second brain must not do.
 */
const assemble = (items: readonly NodeSummary[]): Hierarchy => {
  const building = new Map<number, Building>();

  for (const summary of items) {
    if (building.has(summary.id)) {
      return inconsistent('The same container arrived twice while the hierarchy was being read.');
    }

    // The request asked for containers only, so a resource here means the answer did not match the
    // question. Refused rather than filtered out: silently dropping rows would turn a server that is
    // answering the wrong question into a hierarchy that merely looks a little short, and the children
    // of a dropped row would then read as orphans against a cause nobody could see.
    if (!isContainerType(summary.type)) {
      return inconsistent('Something that is not an area or a project arrived in the hierarchy.');
    }

    building.set(summary.id, { summary: { ...summary, type: summary.type }, children: [] });
  }

  const roots: ContainerSummary[] = [];

  for (const { summary } of building.values()) {
    if (summary.parentId === null) {
      if (summary.type !== 'area') {
        return inconsistent('A project was reported at the top level, where only areas can be.');
      }

      roots.push(summary);
      continue;
    }

    const parent = building.get(summary.parentId);

    if (parent === undefined) {
      return inconsistent('A container arrived whose parent did not.');
    }

    if (parent.summary.type !== 'area') {
      return inconsistent('A container was reported inside a project, which holds none.');
    }

    parent.children.push(summary);
  }

  // A cycle would make the walk below recur forever. It cannot happen in a tree the server built,
  // which is why it is checked rather than assumed: the check is cheap and the failure is a hang.
  for (const { summary } of building.values()) {
    const seen = new Set<number>([summary.id]);
    let cursor = summary.parentId;

    while (cursor !== null) {
      if (seen.has(cursor)) return inconsistent('The containers describe a loop.');

      seen.add(cursor);
      cursor = building.get(cursor)?.summary.parentId ?? null;
    }
  }

  const byId = new Map<number, HierarchyNode>();

  const build = (summary: ContainerSummary): HierarchyNode => {
    const entry = building.get(summary.id);
    const children = (entry?.children ?? []).slice().sort(compareNodeOrder).map(build);
    const node: HierarchyNode = {
      id: summary.id,
      type: summary.type,
      parentId: summary.parentId,
      slug: summary.slug,
      title: summary.title,
      description: summary.description,
      children,
    };
    byId.set(node.id, node);

    return node;
  };

  return { roots: roots.slice().sort(compareNodeOrder).map(build), byId };
};

/** The whole hierarchy, or a throw. Never anything in between. */
export const fetchHierarchy = async (list: ListFn, signal?: AbortSignal): Promise<Hierarchy> =>
  assemble(await fetchPages(list, signal));

/* ------------------------------------------------------------------ reading an assembled tree */

/** Ancestors from the top-level area down to and including `id`, or empty when it is not here. */
export const pathTo = (hierarchy: Hierarchy, id: number): readonly HierarchyNode[] => {
  const steps: HierarchyNode[] = [];
  let cursor: number | null = id;

  while (cursor !== null) {
    const node: HierarchyNode | undefined = hierarchy.byId.get(cursor);

    if (node === undefined) return steps.length === 0 ? [] : steps;

    steps.unshift(node);
    cursor = node.parentId;
  }

  return steps;
};

/** Every area in the hierarchy, depth-first in listing order. */
export const allAreas = (hierarchy: Hierarchy): readonly HierarchyNode[] => {
  const found: HierarchyNode[] = [];

  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      if (node.type !== 'area') continue;

      found.push(node);
      walk(node.children);
    }
  };

  walk(hierarchy.roots);

  return found;
};

/** Every container in a subtree, including its root. Used to scope a search. */
export const subtreeIds = (hierarchy: Hierarchy, id: number): ReadonlySet<number> => {
  const ids = new Set<number>();

  const walk = (node: HierarchyNode): void => {
    ids.add(node.id);

    for (const child of node.children) walk(child);
  };

  const start = hierarchy.byId.get(id);

  if (start !== undefined) walk(start);

  return ids;
};

/**
 * An area, and enough of where it sits to tell it from another area with the same name.
 *
 * Two areas called "Notes" under different parents are an ordinary thing to have, and a picker
 * that lists both by name alone is a picker that cannot be used correctly. The context is built
 * from the hierarchy's own parent links, which is why it needs the complete tree: a partial read
 * would produce a shorter path for an area whose ancestors had not arrived, and a shorter path
 * here is a different claim about where something is.
 */
export interface AreaOption {
  readonly id: number;
  readonly title: string;
  /** Ancestor titles, top down, joined. Empty for a top-level area. */
  readonly context: string;
  /** Title and context together, lowercased, so filtering matches what is on screen. */
  readonly haystack: string;
}

export const areaOptions = (hierarchy: Hierarchy): readonly AreaOption[] =>
  allAreas(hierarchy).map((area) => {
    const context = pathTo(hierarchy, area.id)
      .slice(0, -1)
      .map((step) => step.title)
      .join(' / ');

    return {
      id: area.id,
      title: area.title,
      context,
      haystack: `${area.title} ${context}`.toLowerCase(),
    };
  });

/**
 * A canonical path from Get Path, as the segments a location chip renders.
 *
 * Text only. These are slugs, they are never turned into identities, and nothing is navigable from
 * them - they exist so a screen that cannot name its location in titles can still say truthfully
 * where it is rather than inventing somewhere plausible. An empty result is the honest answer when
 * there is nothing to show, and the chip is built to admit it.
 */
export const pathSegments = (path: string | undefined): readonly string[] =>
  path === undefined ? [] : path.split('/').filter((segment) => segment !== '');
