import { NODE_ROUTES } from '@raphael/contracts/nodes';
import { Effect } from 'effect';

import type { Db } from '../../infrastructure/database/index.ts';
import type { OperationFailure, OperationRoute } from '../../infrastructure/http/operation.ts';
import { archiveNode, restoreNode } from './archive.ts';
import { createNode } from './create.ts';
import { toPublicError, type NodeError } from './errors.ts';
import { addFavorite, listFavorites, removeFavorite } from './favorites.ts';
import { getNodePath } from './get-path.ts';
import { getNode } from './get.ts';
import { listNodes } from './list.ts';
import { moveNode } from './move.ts';
import { searchNodes } from './search.ts';
import { updateNode } from './update.ts';

/**
 * The capability publishes its own routes and projects its own failures with `toPublicError`. Only
 * `InternalFailure` is logged, with its sanitized `detail` and never its `cause`.
 */
const failureOf = (error: NodeError): OperationFailure => {
  const projected = toPublicError(error);
  const failure: OperationFailure = {
    error: { code: projected.code, message: projected.message },
  };
  return error._tag === 'InternalFailure'
    ? { ...failure, diagnostic: { stage: error.operation, detail: error.detail } }
    : failure;
};

const adapt =
  <A>(operation: (request: unknown) => Effect.Effect<A, NodeError, Db>) =>
  (body: unknown): Effect.Effect<A, OperationFailure, Db> =>
    Effect.mapError(operation(body), failureOf);

/** Creation answers 201; everything else answers 200. */
export const nodeRoutes: readonly OperationRoute[] = [
  {
    descriptor: NODE_ROUTES.create,
    label: 'nodes.create',
    successStatus: 201,
    run: adapt(createNode),
  },
  { descriptor: NODE_ROUTES.get, label: 'nodes.get', successStatus: 200, run: adapt(getNode) },
  { descriptor: NODE_ROUTES.list, label: 'nodes.list', successStatus: 200, run: adapt(listNodes) },
  {
    descriptor: NODE_ROUTES.search,
    label: 'nodes.search',
    successStatus: 200,
    run: adapt(searchNodes),
  },
  {
    descriptor: NODE_ROUTES.getPath,
    label: 'nodes.get-path',
    successStatus: 200,
    run: adapt(getNodePath),
  },
  {
    descriptor: NODE_ROUTES.update,
    label: 'nodes.update',
    successStatus: 200,
    run: adapt(updateNode),
  },
  { descriptor: NODE_ROUTES.move, label: 'nodes.move', successStatus: 200, run: adapt(moveNode) },
  {
    descriptor: NODE_ROUTES.archive,
    label: 'nodes.archive',
    successStatus: 200,
    run: adapt(archiveNode),
  },
  {
    descriptor: NODE_ROUTES.restore,
    label: 'nodes.restore',
    successStatus: 200,
    run: adapt(restoreNode),
  },
  {
    descriptor: NODE_ROUTES.addFavorite,
    label: 'favorites.add',
    successStatus: 200,
    run: adapt(addFavorite),
  },
  {
    descriptor: NODE_ROUTES.removeFavorite,
    label: 'favorites.remove',
    successStatus: 200,
    run: adapt(removeFavorite),
  },
  {
    descriptor: NODE_ROUTES.listFavorites,
    label: 'favorites.list',
    successStatus: 200,
    run: adapt(listFavorites),
  },
];
