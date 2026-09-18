import { decodeGetRequest, decodeGetResponse, type GetResponse } from '@raphael/contracts/nodes';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { GET_FIELDS, invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import {
  bodyProjection,
  checkedResponse,
  entityProjection,
  validatedStoredBody,
} from './projection.ts';
import { loadEntity } from './resolve.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';

const OPERATION = 'nodes.get';

/**
 * Reading one entity in the requested body format.
 *
 * The read and the projection are deliberately separated. Selector resolution and the row fetch happen
 * inside one synchronous read transaction, which copies out plain values; validating the stored body and
 * converting it to Markdown then happens outside, where it holds no transaction open while doing the
 * most expensive work in the operation.
 *
 * No path is computed. A full path is only ever produced on explicit request, so an ordinary read does
 * not pay for an ancestor walk and no client can start depending on an address it did not ask for.
 */
export const getNode = (input: unknown): Effect.Effect<GetResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const row = yield* Effect.try({
      try: () => {
        const request = decodeGetRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, GET_FIELDS, input));
        }
        const { target, format } = request.right;
        const found = readTransaction(db, () => loadEntity(orm(db), target, 'target', OPERATION));
        return { found, format };
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'read' }, cause),
    });

    return yield* Effect.try({
      try: () => {
        const document = validatedStoredBody(row.found.body, OPERATION);
        return checkedResponse(
          decodeGetResponse,
          {
            entity: entityProjection(row.found, bodyProjection(document, row.format), OPERATION),
          },
          OPERATION,
        );
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'projection' }, cause),
    });
  });
