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
import { ARCHIVED_CONTAINERS, IS_ARCHIVED } from './lifecycle.ts';
import { SUMMARY_COLUMNS, summaryProjection } from './projection.ts';
import { resolveEntity, type Selector } from './resolve.ts';
import { favorites } from './schema.ts';
import { windowFragment } from './scope-page.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction, writeTransaction } from './store.ts';
import type { NodeType, StoredSummary } from './types.ts';

const ADD = 'favorites.add';
const REMOVE = 'favorites.remove';
const LIST = 'favorites.list';

/** Named from the contracts' container list, so widening it is a deliberate edit here too. */
const FAVORABLE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(CONTAINER_TYPES);

/**
 * Favorites are a separate collection of node ids. No revision is read or written, add and remove
 * state the result they leave (so repeating either is harmless), and an archived node can still be
 * marked; the list hides it until it is restored.
 */
export const addFavorite = (input: unknown): Effect.Effect<AddFavoriteResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const target = decodedTarget(input);
        return writeTransaction(db, () => {
          const handle = orm(db);
          const node = resolveEntity(handle, target, 'target', ADD);
          if (!FAVORABLE_TYPES.has(node.type)) {
            return raise(
              new InvalidInput({ field: 'target', reason: 'favorite_requires_container' }),
            );
          }
          handle.insert(favorites).values({ nodeId: node.id }).onConflictDoNothing().run();
          return { nodeId: node.id, isFavorite: true as const };
        });
      },
      catch: (cause) => unwrapFailure({ operation: ADD, stage: 'write' }, cause),
    });
  });

/** Ensures absence. An id that names nothing succeeds; a path must resolve. */
export const removeFavorite = (
  input: unknown,
): Effect.Effect<RemoveFavoriteResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const target = decodedTarget(input);
        return writeTransaction(db, () => {
          const handle = orm(db);
          const nodeId =
            'id' in target ? target.id : resolveEntity(handle, target, 'target', REMOVE).id;
          handle.delete(favorites).where(eq(favorites.nodeId, nodeId)).run();
          return { nodeId, isFavorite: false as const };
        });
      },
      catch: (cause) => unwrapFailure({ operation: REMOVE, stage: 'write' }, cause),
    });
  });

/** One page of favorites that are not archived, by title without regard to ASCII case, then id. */
export const listFavorites = (input: unknown): Effect.Effect<ListResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.try({
      try: () => {
        const request = decodeFavoriteListRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { skip, limit } = request.right;

        const rows = readTransaction(db, () =>
          orm(db).all<StoredSummary>(sql`
            WITH RECURSIVE ${ARCHIVED_CONTAINERS}
            SELECT ${SUMMARY_COLUMNS} FROM favorites listed JOIN nodes n ON n.id = listed.node_id
            WHERE NOT ${IS_ARCHIVED}
            ORDER BY n.title COLLATE NOCASE ASC, n.id ASC
            ${windowFragment(skip, limit)}`),
        );

        return {
          // The `WHERE` already excluded every archived row.
          items: rows.slice(0, limit).map((row) => summaryProjection(row, false)),
          skip,
          limit,
          hasMore: rows.length > limit,
        };
      },
      catch: (cause) => unwrapFailure({ operation: LIST, stage: 'page read' }, cause),
    });
  });

/** Decodes an add or remove request and detaches its selector, so what is validated is what is used. */
const decodedTarget = (input: unknown): Selector => {
  const request = decodeFavoriteRequest(input);
  if (Either.isLeft(request)) return raise(invalidInputFrom(request.left, input));
  const { target } = request.right;
  return 'id' in target ? { id: target.id } : { path: target.path };
};
