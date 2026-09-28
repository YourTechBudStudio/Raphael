import {
  SLUG_MAX_CODE_POINTS,
  decodeMoveRequest,
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
import { invalidInputFrom } from './diagnostics.ts';
import {
  InvalidInput,
  InvalidParent,
  RevisionConflict,
  SlugConflict,
  type NodeError,
} from './errors.ts';
import { requireActive, requireMovable } from './lifecycle.ts';
import { summaryProjection } from './projection.ts';
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
 * Moves one entity, optionally renaming its slug, in one write transaction checked against the
 * caller's revision. Only the target row is written; paths are computed on request.
 *
 * Order is the contract: a stale revision first, then a cycle before a type mismatch, then lifecycle.
 * A target archived by its own cause must be restored first; one archived only through an ancestor may
 * move out. An unchanged location answers without writing.
 */
export const moveNode = (input: unknown): Effect.Effect<MoveResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      const prepared = yield* Effect.try({
        try: () => {
          const request = decodeMoveRequest(input);
          if (Either.isLeft(request)) {
            return raise(invalidInputFrom(request.left, input));
          }
          return prepareMove(request.right);
        },
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'request preparation' }, cause),
      });

      return yield* Effect.try({
        try: () => writeTransaction(db, () => commit(db, prepared, clock)),
        // The slug clash is classified inside `commit`, around the one statement that can raise it.
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
 * A parent selector names the parent and optionally a new slug. A path that names a container (or the
 * root) is the parent, and the target keeps its slug; one that names a note is taken; any other path is
 * an address whose last segment is the new slug.
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

  const segments = parsePath(destination.path);
  const slug = Either.isRight(segments) ? segments.right.at(-1) : undefined;
  if (Either.isLeft(segments) || slug === undefined) {
    return raise(new InvalidInput({ field: 'destination', reason: 'invalid' }));
  }
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

const commit = (
  db: Database.Database,
  prepared: PreparedMove,
  clock: Clock.Clock,
): MoveResponse => {
  const handle = orm(db);

  const target = loadSummary(handle, prepared.target, 'target', OPERATION);
  if (target.revision !== prepared.revision) {
    return raise(new RevisionConflict({ current: target.revision }));
  }

  const { parentScope, slug } = resolveDestination(handle, prepared.destination, target);

  const nextParent = parentScope.kind === 'root' ? null : parentScope.node;
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
  requireMovable(handle, target, OPERATION);
  requireActive(handle, nextParent, 'destination', OPERATION);

  const nextParentId = nextParent?.id ?? null;
  const unchanged = nextParentId === target.parentId && slug === target.slug;
  const revision = unchanged ? target.revision : target.revision + 1;

  // Not archived: the target has no cause of its own and its new parent is active.
  const response = {
    node: summaryProjection({ ...target, parentId: nextParentId, slug, revision }, false),
  };
  if (unchanged) return response;

  const now = sampleNow(clock, OPERATION);
  try {
    handle
      .update(nodes)
      .set({
        parentId: nextParentId,
        parentType: nextParent?.type ?? null,
        slug,
        revision,
        updatedAt: now,
      })
      .where(and(eq(nodes.id, target.id), eq(nodes.revision, prepared.revision)))
      .run();
  } catch (cause) {
    // The retained or the new slug can clash in the destination.
    return raise(classifyFailure({ operation: OPERATION, stage: 'write', slug }, cause));
  }
  return response;
};
