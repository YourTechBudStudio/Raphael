import {
  CONTAINER_TYPES,
  decodeAddFavoriteResponse,
  decodeFavoriteListRequest,
  decodeFavoriteRequest,
  decodeListResponse,
  decodeRemoveFavoriteResponse,
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
import { SUMMARY_COLUMNS, checkedResponse, summaryProjection } from './projection.ts';
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
 * Favorites: a separate collection of node identities (story #14).
 *
 * ```text
 * add    decode → immediate write transaction: resolve, require a container, insert if absent
 * remove decode → immediate write transaction: resolve a path (an id needs none), delete if present
 * list   decode → read transaction: favorites joined to nodes, archived hidden, ordered, windowed
 * ```
 *
 * - **No revision** is read, required or written. A favorite is not part of what a revision guards, so
 *   toggling one can never disturb an edit in progress, and `updated_at` stays put too.
 * - **Desired state, not a toggle.** Add and remove each answer the state they leave behind, so
 *   repeating either is harmless. The table's primary key is what makes a repeated add write nothing.
 * - **No archive check** on add or remove: something archived can still be marked and unmarked, and the
 *   list hides it until it is restored, by the one rule `lifecycle.ts` owns.
 * - **Nothing is copied.** Titles and archive status are read from the node on every list.
 * - This is the only module that writes `favorites`; `projection.ts::favoriteExpression` is the only
 *   reader of membership on node responses.
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
          // Areas and projects only in this story (#14). Notes are the case refused today, and the notes
          // story lifts this check. Anything that is not a container is refused rather than only notes,
          // so a type added later is not quietly accepted. The node exists, so this is not a missing
          // node: it is the named target that does not fit, with a reason saying why.
          if (!FAVORABLE_TYPES.has(node.type)) {
            return raise(
              new InvalidInput({ field: 'target', reason: 'favorite_requires_container' }),
            );
          }
          handle.insert(favorites).values({ nodeId: node.id }).onConflictDoNothing().run();
          return checkedResponse(
            decodeAddFavoriteResponse,
            { nodeId: node.id, isFavorite: true },
            ADD,
          );
        });
      },
      catch: (cause) => unwrapFailure({ operation: ADD, stage: 'write' }, cause),
    });
  });

/**
 * Remove simply ensures absence. An id that names nothing has nothing to remove, so it succeeds. A path
 * must resolve, because a path that names nothing identifies no node to answer about. There is no type
 * check: a note can never hold a row, so removing one succeeds and changes nothing.
 */
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
          return checkedResponse(
            decodeRemoveFavoriteResponse,
            { nodeId, isFavorite: false },
            REMOVE,
          );
        });
      },
      catch: (cause) => unwrapFailure({ operation: REMOVE, stage: 'write' }, cause),
    });
  });

/**
 * One page of favorites that are not archived, by title without regard to ASCII case, then by id.
 *
 * Filtering, ordering and the `LIMIT limit+1` window are one statement, so a page is cut after the
 * archived rows are gone and `hasMore` is observed rather than counted. The archive rule is
 * `lifecycle.ts`'s own SQL form, so a favorite reappears on restore exactly when no cause of its own or
 * of another ancestor remains.
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
        const { skip, limit } = request.right;

        const rows = readTransaction(db, () =>
          orm(db).all<StoredSummary>(sql`
            WITH RECURSIVE ${ARCHIVED_CONTAINERS}
            SELECT ${SUMMARY_COLUMNS} FROM favorites listed JOIN nodes n ON n.id = listed.node_id
            WHERE NOT ${IS_ARCHIVED}
            ORDER BY n.title COLLATE NOCASE ASC, n.id ASC
            ${windowFragment(skip, limit)}`),
        );

        return checkedResponse(
          decodeListResponse,
          {
            // `false`: the `WHERE` already excluded every archived row, as a default scope page does.
            items: rows.slice(0, limit).map((row) => summaryProjection(row, false, LIST)),
            skip,
            limit,
            hasMore: rows.length > limit,
          },
          LIST,
        );
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
