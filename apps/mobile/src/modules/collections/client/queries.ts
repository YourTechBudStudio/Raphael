import { get as getNode, getPath, list } from '@raphael/client/nodes';
import { CONTAINER_TYPES, type CreateResponse, type GetResponse } from '@raphael/contracts/nodes';
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { unwrap } from '../../../infrastructure/query/failure';
import { activationOf, scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession, type ConnectionSession } from '../../connection';
import {
  fetchHierarchy,
  HierarchyRefusedError,
  pathTo,
  type Hierarchy,
  type HierarchyNode,
} from './hierarchy';

/**
 * The hierarchy, one entity, and one canonical path: everything the container screens read.
 *
 * There is exactly one hierarchy query in the app. Every screen that needs to know what is inside
 * an area reads it from that one result rather than issuing its own List, because two reads of the
 * same fact can disagree and a person looking at a tree and an area screen at once would see the
 * disagreement. Get is still its own request, because the tree carries summaries and a screen needs
 * the body.
 *
 * That does not make the cache an authority. Get and the hierarchy are two server projections
 * refreshed on their own schedules, and neither is derived from the other.
 *
 * Every key is stamped with the connection activation, and every query function captures the
 * session's transport rather than reading the current one when it runs. A read issued against one
 * server therefore stays a read against that server even if the connection changes underneath it,
 * and lands in a key nothing is looking at.
 */

const HIERARCHY = 'hierarchy';

const keys = {
  hierarchy: (activation: number) => scopeKey(activation, HIERARCHY),
  entity: (activation: number, ref: ContainerRef) =>
    scopeKey(activation, 'entity', ref.type, ref.id),
  path: (activation: number, id: number) => scopeKey(activation, 'path', id),
};

/**
 * A container was created or moved under `activation`: that connection's hierarchy is stale.
 *
 * The one cache entry point other capabilities are given, so nothing outside this module has to
 * know the key.
 *
 * **Scoped to one activation, deliberately.** The predicate used to match on the key's third element
 * alone, which meant every connection's hierarchy - including retired ones nothing is reading. A
 * completion arriving from a connection that has since been switched away from would have marked the
 * current connection's hierarchy stale and pulled a fresh read of a server that had nothing to do
 * with it.
 */
export function invalidateHierarchy(client: QueryClient, activation: number): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      activationOf(query.queryKey) === activation && query.queryKey[2] === HIERARCHY,
  });
}

/**
 * One container changed on `activation`: its entity is stale.
 *
 * Beside `invalidateHierarchy` and scoped the same way, so an update answered under a connection the
 * app has since left cannot pull a fresh read of a server that has nothing to do with it. It
 * invalidates rather than writing what the server returned: a response written into the cache would
 * make the update a second authority on ordering between concurrent clients, and the next read is the
 * one that should decide.
 */
export function invalidateContainer(
  client: QueryClient,
  activation: number,
  ref: ContainerRef,
): Promise<void> {
  const key = keys.entity(activation, ref);

  return client.invalidateQueries({
    predicate: (query) =>
      activationOf(query.queryKey) === activation &&
      query.queryKey.length === key.length &&
      key.every((segment, index) => query.queryKey[index] === segment),
  });
}

/**
 * An address changed, so every computed path that may contain it is stale.
 *
 * Every path on this activation, not just this container's: the server composes a path from its
 * ancestors' slugs, so moving or re-addressing an area changes the canonical path of everything beneath
 * it.
 */
export function invalidatePaths(client: QueryClient, activation: number): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) =>
      activationOf(query.queryKey) === activation && query.queryKey[2] === 'path',
  });
}

/**
 * A creation landed: hold on to what the server said, and mark the hierarchy stale.
 *
 * Seeding is absent-only. That is not because a container we just created is usually the newest
 * thing known about it - it is because writing only where nothing is cached can never overwrite a
 * reading that is already there, and a replay can return a snapshot from days ago. Where something
 * is cached, this leaves it alone and lets the ordinary refetch decide.
 *
 * Kept beside the invalidation rather than exported separately: they are one consequence of one
 * event, and creation lives inside this capability, so neither needs to become a public API to be
 * reachable by the code that calls them.
 */
export async function recordCreation(
  client: QueryClient,
  response: CreateResponse,
  activation: number,
): Promise<void> {
  const entity = response.entity;

  // The entity cache this seeds is keyed by a container reference, and every screen reading it expects
  // an area or a project. A resource creation therefore seeds nothing here rather than being filed
  // under a reference no reader can address - the note screens land in Phase 05 with their own key.
  // The hierarchy is still invalidated either way: a creation happened, and a stale tree is a stale
  // tree whatever was added to it.
  if ((CONTAINER_TYPES as readonly string[]).includes(entity.type)) {
    const key = keys.entity(activation, {
      type: entity.type as (typeof CONTAINER_TYPES)[number],
      id: entity.id,
    });
    if (client.getQueryData(key) === undefined) client.setQueryData(key, entity);
  }

  await invalidateHierarchy(client, activation);
}

export interface HierarchyQuery {
  readonly hierarchy: Hierarchy | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  /** True while a refresh is running, including one that is replacing a failed read. */
  readonly isFetching: boolean;
  /**
   * True when the hierarchy on screen came from an earlier successful read and the most recent
   * refresh failed. What is shown is complete and was true; it is not current.
   */
  readonly isStale: boolean;
  /**
   * What the server's answers were refused for, when they were refused rather than unreachable.
   *
   * Set only when the pages arrived and did not describe a hierarchy this app can hold - too many
   * containers, or pages that contradict each other. It carries its own sentence because the
   * generic "did not load" is true of a timeout and of a 20,001st container alike, and only one of
   * those is worth trying again. Null for every ordinary transport failure, which the screens
   * already have words for.
   */
  readonly refusal: { readonly message: string; readonly retryable: boolean } | null;
  readonly refetch: () => void;
}

/**
 * The whole container hierarchy.
 *
 * A failed refresh keeps the last complete hierarchy visible and reports itself, rather than
 * blanking the app because one request timed out. `isStale` is what lets a screen say which of the
 * two it is showing; it is never true for a partial read, because a partial read is never published.
 */
export function useHierarchy(): HierarchyQuery {
  const session = useConnectionSession();
  const query = useQuery({
    queryKey: keys.hierarchy(session?.activation ?? -1),
    queryFn: ({ signal }) => runHierarchy(session, signal),
    enabled: session !== null,
  });

  const error = query.error;

  return {
    hierarchy: query.data,
    isPending: query.isPending,
    isError: query.isError,
    isFetching: query.isFetching,
    isStale: query.isError && query.data !== undefined,
    refusal:
      error instanceof HierarchyRefusedError
        ? { message: error.message, retryable: error.retryable }
        : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

const runHierarchy = (
  session: ConnectionSession | null,
  signal: AbortSignal,
): Promise<Hierarchy> => {
  if (session === null) throw new Error('No connection');

  // The transport is captured here, not read at request time, so a connection change mid-traversal
  // cannot retarget the remaining pages at a different server.
  const { transport } = session;

  return fetchHierarchy((request, pageSignal) => list(transport, request, pageSignal), signal);
};

/** One container, with its body. Null `ref` means there is nothing to ask about. */
export function useContainer(ref: ContainerRef | null): UseQueryResult<GetResponse['entity']> {
  const session = useConnectionSession();

  return useQuery({
    queryKey: keys.entity(session?.activation ?? -1, ref ?? { type: 'area', id: 0 }),
    queryFn: async ({ signal }) => {
      if (session === null || ref === null) throw new Error('No connection');

      return unwrap(await getNode(session.transport, { target: { id: ref.id } }, signal)).entity;
    },
    enabled: session !== null && ref !== null,
  });
}

/**
 * The canonical path text for one container, from the server.
 *
 * This is the authority on where something is, and it is asked exactly when a screen has a path to
 * show and the hierarchy cannot honestly supply one - because it has not loaded, because it failed,
 * or because the reading on hand is no longer current and its titles may have moved. In the ordinary
 * case the hierarchy's titles are what a person wants to read, so nothing is requested at all.
 *
 * Read as text. The server answers with a path and an id, not with the ancestors' identities, so
 * there is nothing here to turn into tappable breadcrumbs - and inventing ancestor identities by
 * splitting the string on slashes would be guessing at containers whose ids this never learned.
 * Splitting it for *display* is fine and is what `pathSegments` does; splitting it into things a
 * person can press is not.
 */
export function useContainerPath(id: number | null): UseQueryResult<string> {
  const session = useConnectionSession();

  return useQuery({
    queryKey: keys.path(session?.activation ?? -1, id ?? 0),
    queryFn: async ({ signal }) => {
      if (session === null || id === null) throw new Error('No connection');

      return unwrap(await getPath(session.transport, { target: { id } }, signal)).path;
    },
    enabled: session !== null && id !== null,
  });
}

/* -------------------------------------------------------- reading children out of the hierarchy */

export interface ContainerChildren {
  readonly subareas: readonly HierarchyNode[];
  readonly projects: readonly HierarchyNode[];
}

/** What an area holds, from the one complete hierarchy. Undefined until it is loaded. */
export const childrenOf = (
  hierarchy: Hierarchy | undefined,
  id: number,
): ContainerChildren | undefined => {
  const node = hierarchy?.byId.get(id);

  if (node === undefined) return undefined;

  return {
    subareas: node.children.filter((child) => child.type === 'area'),
    projects: node.children.filter((child) => child.type === 'project'),
  };
};

/** The ancestors of a container, from the top-level area down to it. Empty when not loaded. */
export const ancestorsOf = (
  hierarchy: Hierarchy | undefined,
  id: number | null,
): readonly HierarchyNode[] =>
  hierarchy === undefined || id === null ? [] : pathTo(hierarchy, id);

/**
 * Names a container for display, or declines to.
 *
 * The rule is the one the Area screen already follows, factored so every card and chip applies it
 * identically. A title is offered only from a hierarchy that has loaded *and* is current. A
 * hierarchy that has not arrived cannot be asked. A hierarchy retained after a failed refresh can be
 * asked and must not be: its titles were true when they were read and may not be now, and a card
 * with one line above the title has nowhere to say which of those it is showing. A plausible name is
 * worse than an honest fallback, because nothing marks it as a guess.
 *
 * Callers fall back to something that is true regardless - a kind label on a card, the server's
 * canonical path on a screen that can afford the request.
 */
export const containerTitleLookup = (
  tree: HierarchyQuery,
): ((id: number) => string | undefined) => {
  const hierarchy = tree.hierarchy;

  if (hierarchy === undefined || tree.isStale) return () => undefined;

  return (id: number) => hierarchy.byId.get(id)?.title;
};
