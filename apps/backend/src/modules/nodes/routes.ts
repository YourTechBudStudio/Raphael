import { NODE_ROUTES } from '@raphael/contracts/nodes';
import { Effect } from 'effect';

import type { Db } from '../../infrastructure/database/index.ts';
import type { OperationFailure, OperationRoute } from '../../infrastructure/http/operation.ts';
import { createNode } from './create.ts';
import { toPublicError, type NodeError } from './errors.ts';
import { getNodePath } from './get-path.ts';
import { getNode } from './get.ts';
import { listNodes } from './list.ts';
import { updateNode } from './update.ts';

/**
 * Where the hierarchy capability publishes itself.
 *
 * The capability owns this, not the host. The addresses come from the shared descriptors, the labels
 * are this capability's own words, the statuses are its decision, and the translation from a tagged
 * failure to a public error is `toPublicError` - the capability's single projection, used here and
 * nowhere reimplemented.
 *
 * `toPublicError` is used for node errors only. Transport conditions - an absent credential, an
 * unknown address, an oversized body - are built by the host from its own fields; passing one through
 * this function to reuse it would make the node error family able to produce transport codes and put
 * transport vocabulary inside this capability's contract.
 */

/**
 * Which failures an operator needs to see.
 *
 * Only `InternalFailure`. Everything else is an expected outcome that the caller is already told
 * about truthfully - a slug collision or a missing parent is not a server problem, and logging it
 * would be an access log assembled one failure at a time.
 *
 * `detail` is the capability's own sanitized words. The retained `cause` is never read here: it can
 * carry SQL text and bound parameters, and no routine log may print it.
 */
const failureOf = (error: NodeError): OperationFailure => {
  const projected = toPublicError(error);
  const failure: OperationFailure = {
    error: { code: projected.code, message: projected.message, details: projected.details },
  };
  return error._tag === 'InternalFailure'
    ? { ...failure, diagnostic: { stage: error.operation, detail: error.detail } }
    : failure;
};

const adapt =
  <A>(operation: (request: unknown) => Effect.Effect<A, NodeError, Db>) =>
  (body: unknown): Effect.Effect<A, OperationFailure, Db> =>
    Effect.mapError(operation(body), failureOf);

/**
 * The request reaches the operation exactly as it was parsed. The host does not decode it, and there
 * is no second validation here: the operation below is the one validation boundary, so a rule cannot
 * be enforced in one place and forgotten in the other.
 *
 * Creation answers 201, including a replay - a replay is a success that reports the entity that
 * exists, not a distinct outcome with a status of its own. Reads answer 200, and so does an update: it
 * changed an entity that already existed rather than bringing one into being.
 */
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
];
