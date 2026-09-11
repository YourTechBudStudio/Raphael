import {
  decodeGetPathRequest,
  decodeGetPathResponse,
  formatPath,
  type GetPathResponse,
} from '@raphael/contracts/nodes';
import { eq } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { GET_PATH_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, type NodeError } from './errors.ts';
import { checkedResponse } from './projection.ts';
import { resolveEntity } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction } from './store.ts';

const OPERATION = 'nodes.getPath';

/**
 * Computing the current address of an entity.
 *
 * The ancestor walk is iterative and carries the set of ids it has already seen. That choice is for
 * legibility rather than necessity - SQL could terminate a recursive walk by deduplicating identities -
 * but it detects a cycle *exactly*, at the row that closes it, without a depth cap. There is no product
 * limit on how deep a hierarchy may be, so a guessed cap would have invented one.
 *
 * Ordinary creation cannot form a cycle, and the parent foreign key is `RESTRICT`, so neither a cycle nor
 * a missing ancestor should be reachable. Both are therefore treated as integrity failures in data we
 * wrote, not as caller errors, and neither is repaired here.
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

          const segments = [node.slug];
          const seen = new Set<number>([node.id]);
          let parentId = node.parentId;
          while (parentId !== null) {
            if (seen.has(parentId)) {
              return raise(
                new InternalFailure({
                  operation: OPERATION,
                  detail: 'stored ancestry contains a cycle',
                }),
              );
            }
            seen.add(parentId);
            const ancestor = handle
              .select({ parentId: nodes.parentId, slug: nodes.slug })
              .from(nodes)
              .where(eq(nodes.id, parentId))
              .get();
            if (ancestor === undefined) {
              return raise(
                new InternalFailure({
                  operation: OPERATION,
                  detail: 'stored ancestry names a node that does not exist',
                }),
              );
            }
            segments.unshift(ancestor.slug);
            parentId = ancestor.parentId;
          }
          return { id: node.id, path: formatPath(segments) };
        });

        return checkedResponse(decodeGetPathResponse, resolved, OPERATION);
      },
      catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'ancestor walk' }, cause),
    });
  });
