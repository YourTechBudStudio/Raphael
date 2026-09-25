import {
  decodeLifecycleRequest,
  decodeLifecycleResponse,
  type LifecycleRequest,
  type LifecycleResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { ARCHIVE_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, RevisionConflict, type NodeError } from './errors.ts';
import { addDirectUserCause, effectiveCauses, removeDirectUserCause } from './lifecycle.ts';
import { causeProjection, checkedResponse, summaryProjection } from './projection.ts';
import { loadSummary, type Selector } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, sampleNow, writeTransaction } from './store.ts';

type Direction = 'archive' | 'restore';

/**
 * Archiving and restoring one entity, against the revision the caller last read. One pipeline with a
 * direction: archive adds the user's direct cause to the target, restore removes it.
 *
 * ```text
 * decode → detach
 *   → immediate write transaction
 *       load the target's summary
 *       require the row to be at the caller's revision
 *       add or remove the user's direct cause           (the primary key decides "already there")
 *       a cause changed → bump the target's revision and timestamp, guarded on the revision
 *       read the causes that apply now
 *       assemble and validate the response
 *     commit
 * ```
 *
 * The shape is `move.ts`'s, for the same reason: everything here is a primary-key or indexed lookup and
 * a summary projection with no body, so the check and the write share one immediate transaction and
 * nothing else can run between them. A projection defect raises inside the transaction and rolls the
 * cause change back.
 *
 * **Only the target is written.** A cause is stored at its origin and status is computed, so archiving a
 * container writes one cause row and the container's own revision and `updated_at`. No descendant row
 * is touched, and no descendant's revision moves (AC6).
 *
 * **No change is a success that writes nothing** (R12). Archiving something the user already archived,
 * or restoring something with no user cause on it, answers without writing and keeps the revision - the
 * move precedent. The revision is still checked first, so a stale caller hears `revision_conflict`.
 *
 * **The answer is the resulting state, not the verb.** The response carries the causes that apply
 * after the change, so a restore of something still archived through an ancestor says so. Take the ADR
 * 0003 example: project 10 carries cause B, note 11 none, and note 12 its own cause A. Restoring 10
 * removes B. Project 10 and note 11 are then active, and note 12 stays archived by A alone.
 *
 * Neither direction can be refused for lifecycle reasons: archive and restore stay available under
 * every standing, which is how an independent cause is added to something already archived.
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
            return raise(invalidInputFrom(request.left, ARCHIVE_FIELDS, input));
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

/** Every decision and the write, in the order that is the algorithm. */
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
    const updated = handle
      .update(nodes)
      .set({ revision, updatedAt: now })
      .where(and(eq(nodes.id, target.id), eq(nodes.revision, prepared.revision)))
      .run().changes;
    if (updated !== 1) {
      return raise(
        new InternalFailure({
          operation,
          detail: 'the guarded lifecycle write matched no row inside its own transaction',
        }),
      );
    }
  }

  // After the change, so the answer is the resulting state.
  const causes = effectiveCauses(handle, target, operation);
  return checkedResponse(
    decodeLifecycleResponse,
    {
      node: summaryProjection({ ...target, revision }, causes.length > 0, operation),
      archiveCauses: causeProjection(causes),
    },
    operation,
  );
};
