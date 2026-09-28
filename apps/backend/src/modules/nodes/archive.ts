import {
  decodeLifecycleRequest,
  type LifecycleRequest,
  type LifecycleResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { RevisionConflict, type NodeError } from './errors.ts';
import { addDirectUserCause, effectiveCauses, removeDirectUserCause } from './lifecycle.ts';
import { causeProjection, summaryProjection } from './projection.ts';
import { loadSummary, type Selector } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, sampleNow, writeTransaction } from './store.ts';

type Direction = 'archive' | 'restore';

/**
 * Archive adds the user's direct cause to the target and restore removes it, in one write transaction
 * checked against the caller's revision (ADR 0003). Only the target row is written; descendants'
 * status is computed. A no-op answers without writing, and the answer carries the causes that apply
 * afterwards, so a restore that leaves something archived through an ancestor says so.
 */
export const archiveNode = (input: unknown): Effect.Effect<LifecycleResponse, NodeError, Db> =>
  lifecycleOperation('archive', input);

export const restoreNode = (input: unknown): Effect.Effect<LifecycleResponse, NodeError, Db> =>
  lifecycleOperation('restore', input);

const OPERATIONS: Readonly<Record<Direction, string>> = {
  archive: 'nodes.archive',
  restore: 'nodes.restore',
};

interface PreparedLifecycle {
  readonly target: Selector;
  readonly revision: number;
}

const lifecycleOperation = (
  direction: Direction,
  input: unknown,
): Effect.Effect<LifecycleResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const operation = OPERATIONS[direction];
      const { db } = yield* Db;

      const prepared = yield* Effect.try({
        try: () => {
          const request = decodeLifecycleRequest(input);
          if (Either.isLeft(request)) {
            return raise(invalidInputFrom(request.left, input));
          }
          return prepareLifecycle(request.right);
        },
        catch: (cause) => unwrapFailure({ operation, stage: 'request preparation' }, cause),
      });

      return yield* Effect.try({
        try: () => writeTransaction(db, () => commit(db, direction, operation, prepared, clock)),
        catch: (cause) => unwrapFailure({ operation, stage: 'write' }, cause),
      });
    }),
  );

/** Detaches the selector, so what is validated is what is used. */
const prepareLifecycle = (request: LifecycleRequest): PreparedLifecycle => ({
  target: 'id' in request.target ? { id: request.target.id } : { path: request.target.path },
  revision: request.revision,
});

const commit = (
  db: Database.Database,
  direction: Direction,
  operation: string,
  prepared: PreparedLifecycle,
  clock: Clock.Clock,
): LifecycleResponse => {
  const handle = orm(db);
  const now = sampleNow(clock, operation);

  const target = loadSummary(handle, prepared.target, 'target', operation);
  if (target.revision !== prepared.revision) {
    return raise(new RevisionConflict({ current: target.revision }));
  }

  const changed =
    direction === 'archive'
      ? addDirectUserCause(handle, target.id, now)
      : removeDirectUserCause(handle, target.id);
  const revision = changed ? target.revision + 1 : target.revision;

  if (changed) {
    handle
      .update(nodes)
      .set({ revision, updatedAt: now })
      .where(and(eq(nodes.id, target.id), eq(nodes.revision, prepared.revision)))
      .run();
  }

  // After the change, so the answer is the resulting state.
  const causes = effectiveCauses(handle, target, operation);
  return {
    node: summaryProjection({ ...target, revision }, causes.length > 0),
    archiveCauses: causeProjection(causes),
  };
};
