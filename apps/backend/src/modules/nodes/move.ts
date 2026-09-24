import {
  SLUG_MAX_CODE_POINTS,
  decodeMoveRequest,
  decodeMoveResponse,
  formatPath,
  isCanonicalSlug,
  parsePath,
  type MoveRequest,
  type MoveResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { MOVE_FIELDS, invalidInputFrom } from './diagnostics.ts';
import {
  InternalFailure,
  InvalidInput,
  InvalidParent,
  RevisionConflict,
  SlugConflict,
  type NodeError,
} from './errors.ts';
import { checkedResponse, summaryProjection } from './projection.ts';
import {
  ancestorChain,
  loadSummary,
  lookupScope,
  resolveScope,
  validateParentage,
  type Selector,
} from './resolve.ts';
import { nodes } from './schema.ts';
import { classifyFailure, raise, unwrapFailure } from './storage-failures.ts';
import { orm, sampleNow, writeTransaction, type Orm } from './store.ts';
import type { ResolvedScope, StoredSummary } from './types.ts';

const OPERATION = 'nodes.move';

/**
 * Relocating one entity, and optionally giving it a new slug, against the revision the caller last read.
 *
 * ```text
 * decode → detach
 *   → immediate write transaction
 *       load the target's summary
 *       require the row to be at the caller's revision
 *       resolve the destination to (parent, slug)       (current state, not an earlier lookup)
 *       refuse a destination that is the target or inside it
 *       refuse a parent that cannot hold the target's type
 *       assemble and validate the response
 *       unchanged location → answer without writing
 *       one UPDATE of the parent pair, slug, revision and timestamp, guarded on the revision
 *     commit
 * ```
 *
 * **One transaction, not update's two.** `update.ts` splits a read from its write because body
 * conversion and projection are unbounded work that must not hold the single writer's lock. A move has
 * no such work: everything here is primary-key or sibling-index lookups and a summary projection with
 * no body. So every current-state decision - revision, destination meaning, ancestry, parentage, and
 * the address the index guards - is made inside the same immediate transaction as the write (ADR 0002),
 * where nothing else can run between the check and the statement. The revision precondition is
 * therefore the verdict, and the `UPDATE`'s guard is kept only for the one-statement discipline the
 * capability follows everywhere; it matching nothing after a passed precondition is our bug.
 *
 * **One row.** Descendants hold only their immediate parent, and paths are computed on request, so a
 * move writes the target's `parent_id`, `parent_type`, `slug`, `revision` and `updated_at` and nothing
 * else: identity, body, descendants and the search index are untouched (the FTS update trigger names
 * only authored text columns).
 *
 * **Order is the contract.** A stale revision is reported before anything about the destination, so a
 * caller whose write is already lost hears that first. A cycle is reported before a type mismatch, so
 * "you cannot move something inside itself" is the answer whenever it is true. Lifecycle checks, when
 * they exist, belong after destination resolution and before the unchanged-location shortcut, so an
 * ineligible entity is refused rather than reported as a harmless no-op.
 *
 * **An unchanged location is a success that writes nothing.** When the destination resolves to the
 * target's current parent and slug, the revision and `updated_at` stay as they are. This is not the
 * content comparison `update.ts` declines to make: the location is two values core has just resolved
 * in this transaction, and a no-op here spares a write and makes a lost answer unambiguous to a client.
 */
export const moveNode = (input: unknown): Effect.Effect<MoveResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      const prepared = yield* Effect.try({
        try: () => {
          const request = decodeMoveRequest(input);
          if (Either.isLeft(request)) {
            return raise(invalidInputFrom(request.left, MOVE_FIELDS, input));
          }
          return prepareMove(request.right);
        },
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'request preparation' }, cause),
      });

      return yield* Effect.try({
        try: () => writeTransaction(db, () => commit(db, prepared, clock)),
        // No slug context here: the one statement that can violate a slug index classifies its own
        // failure with the effective slug inside `commit`, so anything reaching this handler is not an
        // address clash.
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'write' }, cause),
      });
    }),
  );

type PreparedDestination =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'parent'; readonly parent: Selector; readonly slug: string | undefined };

interface PreparedMove {
  readonly target: Selector;
  readonly revision: number;
  readonly destination: PreparedDestination;
}

/** Detaches every pass-through value, so what is validated is what is used. */
const prepareMove = (request: MoveRequest): PreparedMove => {
  const selector = (value: { id: number } | { path: string }): Selector =>
    'id' in value ? { id: value.id } : { path: value.path };
  const { destination } = request;
  return {
    target: selector(request.target),
    revision: request.revision,
    destination:
      'path' in destination
        ? { kind: 'path', path: destination.path }
        : { kind: 'parent', parent: selector(destination.parent), slug: destination.slug },
  };
};

/**
 * The destination rule, owned by core and decided against current state.
 *
 * The explicit form names its parent and optionally a new slug; an omitted slug keeps the target's.
 *
 * The path form is one rule: **a path that currently names a container (or the root) is the parent,
 * and the target keeps its slug. A path that currently names a resource is an address that is taken,
 * and is refused. Any other path is an address: its last segment is the new slug and the rest must
 * name an existing parent.**
 *
 * The resource case is raised here rather than left to the unique index because a row does not
 * conflict with its own index entry: a path naming the target itself would otherwise succeed.
 *
 * The slug bound applies only on the address branch, where the last segment is about to be *written*.
 * The path grammar deliberately leaves segment length unbounded so a path can still name a stored slug
 * written under an older bound, and on the other branches the path names something that exists.
 */
const resolveDestination = (
  handle: Orm,
  destination: PreparedDestination,
  target: StoredSummary,
): { readonly parentScope: ResolvedScope; readonly slug: string } => {
  if (destination.kind === 'parent') {
    return {
      parentScope: resolveScope(handle, destination.parent, 'destination', OPERATION),
      slug: destination.slug ?? target.slug,
    };
  }

  const found = lookupScope(handle, { path: destination.path }, 'destination', OPERATION);
  if (found !== undefined) {
    if (found.kind === 'root' || found.node.type !== 'resource') {
      return { parentScope: found, slug: target.slug };
    }
    return raise(
      new SlugConflict({
        field: 'destination',
        slug: found.node.slug,
        scope: found.node.parentId === null ? 'root' : 'sibling',
      }),
    );
  }

  // `lookupScope` already refused a malformed path and resolved the root, so a path that named nothing
  // has at least one segment; this guard is for the internal caller, as `resolveScope`'s is.
  const segments = parsePath(destination.path);
  const slug = Either.isRight(segments) ? segments.right.at(-1) : undefined;
  if (Either.isLeft(segments) || slug === undefined) {
    return raise(new InvalidInput({ field: 'destination', reason: 'invalid' }));
  }
  // Shape is already guaranteed by `ScopePath`, so length is the only thing this can refuse.
  if (!isCanonicalSlug(slug)) {
    return raise(
      new InvalidInput({
        field: 'destination',
        reason: 'slug_too_long',
        limit: SLUG_MAX_CODE_POINTS,
      }),
    );
  }
  return {
    parentScope: resolveScope(
      handle,
      { path: formatPath(segments.right.slice(0, -1)) },
      'destination',
      OPERATION,
    ),
    slug,
  };
};

/** Every decision and the write, in the order that is the algorithm. */
const commit = (
  db: Database.Database,
  prepared: PreparedMove,
  clock: Clock.Clock,
): MoveResponse => {
  const handle = orm(db);

  // Summary columns only: no body or metadata is read under the writer's lock.
  const target = loadSummary(handle, prepared.target, 'target', OPERATION);
  if (target.revision !== prepared.revision) {
    return raise(new RevisionConflict({ current: target.revision }));
  }

  const { parentScope, slug } = resolveDestination(handle, prepared.destination, target);

  const nextParent = parentScope.kind === 'root' ? null : parentScope.node;
  // The root has no chain and passes. A resource can never be in a chain, but the rule runs uniformly
  // rather than being special-cased by type.
  if (
    nextParent !== null &&
    ancestorChain(handle, nextParent, OPERATION).some((step) => step.id === target.id)
  ) {
    return raise(
      new InvalidParent({
        field: 'destination',
        reason: 'cycle',
        parentType: nextParent.type,
        childType: target.type,
      }),
    );
  }
  validateParentage(parentScope, target.type, 'destination');

  const nextParentId = nextParent?.id ?? null;
  const unchanged = nextParentId === target.parentId && slug === target.slug;
  const revision = unchanged ? target.revision : target.revision + 1;

  // Assembled and validated once, before the branch, so the unchanged-location success crosses the same
  // boundary as every other success. Every field is known before the write; a projection defect raises
  // here and rolls the transaction back having written nothing.
  const response = checkedResponse(
    decodeMoveResponse,
    {
      node: summaryProjection({ ...target, parentId: nextParentId, slug, revision }, OPERATION),
    },
    OPERATION,
  );
  if (unchanged) return response;

  const now = sampleNow(clock, OPERATION);
  let changed: number;
  try {
    changed = handle
      .update(nodes)
      .set({
        parentId: nextParentId,
        parentType: nextParent?.type ?? null,
        slug,
        revision,
        updatedAt: now,
      })
      .where(and(eq(nodes.id, target.id), eq(nodes.revision, prepared.revision)))
      .run().changes;
  } catch (cause) {
    // The only statement that can violate a slug index, so the only place its failure is classified
    // with the effective slug - retained or new, since either can collide in the destination. The
    // parentage CHECKs and the parent foreign key are unreachable after the checks above; if ever hit
    // they classify as internal failures, which is what they would be.
    return raise(classifyFailure({ operation: OPERATION, stage: 'write', slug }, cause));
  }
  if (changed !== 1) {
    return raise(
      new InternalFailure({
        operation: OPERATION,
        detail: 'the guarded move matched no row inside its own transaction',
      }),
    );
  }
  return response;
};
