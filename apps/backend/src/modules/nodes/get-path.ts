import { decodeGetPathRequest, formatPath, type GetPathResponse } from '@raphael/contracts/nodes';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { type NodeError } from './errors.ts';
import { ancestorChain, resolveEntity } from './resolve.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';

const OPERATION = 'nodes.getPath';

/** The slugs of the entity and its ancestors, root first. */
export const getNodePath = (input: unknown): Effect.Effect<GetPathResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    return yield* Effect.try({
      try: () => {
        const request = decodeGetPathRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { target } = request.right;

        return readTransaction(db, () => {
          const handle = orm(db);
          const node = resolveEntity(handle, target, 'target', OPERATION);
          const chain = ancestorChain(handle, node, OPERATION);
          return { id: node.id, path: formatPath(chain.map((step) => step.slug).reverse()) };
        });
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'ancestor walk' }, cause),
    });
  });
