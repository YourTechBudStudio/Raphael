import { decodeGetRequest, type GetResponse } from '@raphael/contracts/nodes';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import { effectiveCauses } from './lifecycle.ts';
import { bodyProjection, entityProjection, storedBody } from './projection.ts';
import { loadEntity } from './resolve.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';

const OPERATION = 'nodes.get';

/** Reads one entity with its archive causes. Markdown conversion runs outside the transaction. */
export const getNode = (input: unknown): Effect.Effect<GetResponse, NodeError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const row = yield* Effect.try({
      try: () => {
        const request = decodeGetRequest(input);
        if (Either.isLeft(request)) {
          return raise(invalidInputFrom(request.left, input));
        }
        const { target, format } = request.right;
        return readTransaction(db, () => {
          const handle = orm(db);
          const found = loadEntity(handle, target, 'target', OPERATION);
          return { found, causes: effectiveCauses(handle, found, OPERATION), format };
        });
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'read' }, cause),
    });

    return yield* Effect.try({
      try: () => ({
        entity: entityProjection(
          row.found,
          bodyProjection(storedBody(row.found.body), row.format),
          row.causes,
        ),
      }),
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'projection' }, cause),
    });
  });
