import {
  CONTAINER_TYPES,
  decodeFavoriteListRequest,
  decodeFavoriteRequest,
  type AddFavoriteResponse,
  type ListResponse,
  type RemoveFavoriteResponse,
} from '@raphael/contracts/nodes';
import { eq, sql } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { InvalidInput, type NodeError } from './errors.ts';
import { ARCHIVED_CONTAINERS, IS_ARCHIVED, effectiveCauses } from './lifecycle.ts';
import { pathOf, pathsOf } from './paths.ts';
import { SUMMARY_COLUMNS, summaryProjection } from './projection.ts';
import { loadSummary, lookupScope, resolveEntity, type Selector } from './resolve.ts';
import { favorites } from './schema.ts';
import { windowFragment } from './scope-page.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction, writeTransaction, type Orm } from './store.ts';
import type { NodeType, StoredNode, StoredPageSummary } from './types.ts';

const ADD = 'favorites.add';
const REMOVE = 'favorites.remove';
const LIST = 'favorites.list';

/** Named from the contracts' container list, so widening it is a deliberate edit here too. */
const FAVORABLE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(CONTAINER_TYPES);

/**
 * Favorites are a separate collection of node ids. No revision is read or written, add and remove
 * state the result they leave (so repeating either is harmless) and say whether this call made the
 * difference, and an archived node can still be marked; the list hides it unless asked to include
 * archived items.
 */
export const addFavorite = (input: unknown): Effect.Effect<AddFavoriteResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const { target, includePaths } = decodedRequest(input);
        return writeTransaction(db, () => {
          const handle = orm(db);
          const node = resolveEntity(handle, target, 'target', ADD);
          if (!FAVORABLE_TYPES.has(node.type)) {
            return raise(
              new InvalidInput({ field: 'target', reason: 'favorite_requires_container' }),
            );
          }
          const changed =
            handle.insert(favorites).values({ nodeId: node.id }).onConflictDoNothing().run()
              .changes === 1;
          return {
            nodeId: node.id,
            isFavorite: true as const,
            changed,
            node: summaryOf(handle, node, includePaths, ADD),
          };
        });
      },
      catch: (cause) => unwrapFailure({ operation: ADD, stage: 'write' }, cause),
    });
  });

/**
 * Ensures absence. An id that names nothing succeeds with no node and `changed: false`; a path must
 * resolve.
 */
export const removeFavorite = (
  input: unknown,
): Effect.Effect<RemoveFavoriteResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const { target, includePaths } = decodedRequest(input);
        return writeTransaction(db, () => {
          const handle = orm(db);
          const found = 'id' in target ? lookupScope(handle, target, 'target', REMOVE) : undefined;
          const node =
            'id' in target
              ? found?.kind === 'node'
                ? found.node
                : undefined
              : resolveEntity(handle, target, 'target', REMOVE);
          const nodeId = node?.id ?? ('id' in target ? target.id : 0);
          const changed =
            handle.delete(favorites).where(eq(favorites.nodeId, nodeId)).run().changes === 1;
          return {
            nodeId,
            isFavorite: false as const,
            changed,
            node: node === undefined ? null : summaryOf(handle, node, includePaths, REMOVE),
          };
        });
      },
      catch: (cause) => unwrapFailure({ operation: REMOVE, stage: 'write' }, cause),
    });
  });

/**
 * One page of favorites by title without regard to ASCII case, then id. Archived favorites are left
 * out unless included, and `archivedLeftOut` says whether any was.
 */
export const listFavorites = (input: unknown): Effect.Effect<ListResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const request = decodeFavoriteListRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { skip, limit, includeArchived, includePaths } = request.right;

        const page = readTransaction(db, () => {
          const handle = orm(db);
          const rows = handle.all<StoredPageSummary>(sql`
            WITH RECURSIVE ${ARCHIVED_CONTAINERS}
            SELECT ${SUMMARY_COLUMNS}, ${includeArchived ? sql`${IS_ARCHIVED}` : sql`0`} AS archived
            FROM favorites listed JOIN nodes n ON n.id = listed.node_id
            ${includeArchived ? sql.empty() : sql`WHERE NOT ${IS_ARCHIVED}`}
            ORDER BY n.title COLLATE NOCASE ASC, n.id ASC
            ${windowFragment(skip, limit)}`);
          const visible = rows.slice(0, limit);
          const archivedLeftOut =
            !includeArchived &&
            handle.get<{ found: number }>(sql`
              WITH RECURSIVE ${ARCHIVED_CONTAINERS}
              SELECT EXISTS (
                SELECT 1 FROM favorites listed JOIN nodes n ON n.id = listed.node_id
                WHERE ${IS_ARCHIVED}
              ) AS found`)?.found === 1;
          return {
            visible,
            hasMore: rows.length > limit,
            archivedLeftOut,
            paths: includePaths
              ? pathsOf(
                  handle,
                  visible.map((row) => row.id),
                  LIST,
                )
              : undefined,
          };
        });

        return {
          items: page.visible.map((row) =>
            summaryProjection(row, row.archived === 1, page.paths?.get(row.id)),
          ),
          skip,
          limit,
          hasMore: page.hasMore,
          archivedLeftOut: page.archivedLeftOut,
        };
      },
      catch: (cause) => unwrapFailure({ operation: LIST, stage: 'page read' }, cause),
    });
  });

/** Decodes an add or remove request and detaches its selector, so what is validated is what is used. */
const decodedRequest = (
  input: unknown,
): { readonly target: Selector; readonly includePaths: boolean } => {
  const request = decodeFavoriteRequest(input);
  if (Either.isLeft(request)) return raise(invalidInputFrom(request.left, input));
  const { target, includePaths } = request.right;
  return { target: 'id' in target ? { id: target.id } : { path: target.path }, includePaths };
};

/** The marked item as it stands after the change, so an answer can name what it marked. */
const summaryOf = (handle: Orm, node: StoredNode, includePaths: boolean, operation: string) =>
  summaryProjection(
    loadSummary(handle, { id: node.id }, 'target', operation),
    effectiveCauses(handle, node, operation).length > 0,
    includePaths ? pathOf(handle, node, operation) : undefined,
  );
