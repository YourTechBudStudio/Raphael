import {
  decodeGetPathRequest,
  decodeGetPathResponse,
  formatPath,
  type GetPathResponse,
} from '@raphael/contracts/nodes';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { GET_PATH_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { type NodeError } from './errors.ts';
import { checkedResponse } from './projection.ts';
import { ancestorChain, resolveEntity } from './resolve.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';

const OPERATION = 'nodes.getPath';

/**
 * Computing the current address of an entity.
 *
 * The address is the slugs of the entity and its ancestors, root first. The walk is `ancestorChain`,
 * shared with the move's cycle check so there is one statement of how ancestry is traversed and what a
 * stored cycle or a missing ancestor means: both are integrity failures in data we wrote, not caller
 * errors, and neither is repaired here.
 */
export const getNodePath = (input: unknown): Effect.Effect<GetPathResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeGetPathRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, GET_PATH_FIELDS, input));
        }
        const { target } = request.right;

        const resolved = readTransaction(db, () => {
          const handle = orm(db);
          const node = resolveEntity(handle, target, 'target', OPERATION);
          const chain = ancestorChain(handle, node, OPERATION);
          return { id: node.id, path: formatPath(chain.map((step) => step.slug).reverse()) };
        });

        return checkedResponse(decodeGetPathResponse, resolved, OPERATION);
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'ancestor walk' }, cause),
    });
  });
