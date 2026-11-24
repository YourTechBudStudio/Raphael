import { deriveText } from '@raphael/content/schema';
import type { JsonObject } from '@raphael/contracts';
import {
  decodeUpdateRequest,
  type BodyFormat,
  type UpdateRequest,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { convertBody, type PreparedBody } from './content.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { InvalidInput, RevisionConflict, type NodeError } from './errors.ts';
import { requireActive } from './lifecycle.ts';
import { pathOf } from './paths.ts';
import { bodyProjection, entityProjection, storedBody } from './projection.ts';
import { loadEntity, withSlugHolder, type Selector } from './resolve.ts';
import { nodes } from './schema.ts';
import { classifyFailure, raise, unwrapFailure } from './storage-failures.ts';
import { orm, sampleNow, writeTransaction } from './store.ts';
import type { StoredEntity } from './types.ts';

const OPERATION = 'nodes.update';

/**
 * Changes one entity against the revision the caller last read. The body is converted first; then one
 * write transaction checks the revision and lifecycle, writes, and reads the row back for the answer.
 *
 * An update whose every submitted value equals the stored one writes nothing: the revision and update
 * time stay, and the answer says `changed: false`. The body is compared in its stored canonical form,
 * after conversion, so Markdown that converts to the stored document is no change. The revision is
 * still checked first, and an archived target is still refused, so a no-op is never an answer about a
 * state the caller did not read. A title change never re-derives the slug (ADR 0004).
 */
export const updateNode = (input: unknown): Effect.Effect<UpdateResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      const prepared = yield* Effect.try({
        try: () => {
          const request = decodeUpdateRequest(input);
          if (Either.isLeft(request)) {
            return raise(invalidInputFrom(request.left, input));
          }
          return prepareUpdate(request.right);
        },
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'request preparation' }, cause),
      });

      const converted =
        prepared.body === undefined ? undefined : yield* convertBody(prepared.body, OPERATION);
      const content =
        converted === undefined
          ? undefined
          : yield* Effect.try({
              try: () => ({ stored: JSON.stringify(converted), text: deriveText(converted) }),
              catch: (cause) =>
                unwrapFailure({ operation: OPERATION, stage: 'body projection' }, cause),
            });

      const written = yield* Effect.try({
        try: () => writeTransaction(db, () => commit(db, prepared, content, clock)),
        // The slug clash is classified inside `commit`, around the one statement that can raise it.
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'write' }, cause),
      }).pipe(Effect.mapError((error) => withSlugHolder(orm(db), error)));

      return yield* Effect.try({
        try: () => ({
          // Not archived: the write required an active target.
          entity: entityProjection(
            written.entity,
            bodyProjection(converted ?? storedBody(written.entity.body), prepared.format),
            [],
            written.path,
          ),
          changed: written.changed,
          ...(written.previousPath === undefined ? {} : { previousPath: written.previousPath }),
        }),
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'response projection' }, cause),
      });
    }),
  );

/** Each optional is `undefined` exactly when the caller omitted it, so `description: ''` clears. */
interface PreparedUpdate {
  readonly target: Selector;
  readonly revision: number;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly slug: string | undefined;
  readonly body: PreparedBody | undefined;
  /** The full resulting list. */
  readonly tags: readonly string[] | undefined;
  readonly active: boolean | undefined;
  readonly format: BodyFormat;
  readonly includePaths: boolean;
}

const prepareUpdate = (request: UpdateRequest): PreparedUpdate => ({
  target: 'id' in request.target ? { id: request.target.id } : { path: request.target.path },
  revision: request.revision,
  title: request.title === undefined ? undefined : request.title.trim(),
  description: request.description,
  slug: request.slug,
  body:
    request.body === undefined
      ? undefined
      : request.body.format === 'tiptap'
        ? { format: 'tiptap', value: request.body.value as JsonObject }
        : { format: 'markdown', value: request.body.value },
  tags: request.tags,
  active: request.active,
  format: request.format,
  includePaths: request.includePaths,
});

const commit = (
  db: Database.Database,
  prepared: PreparedUpdate,
  content: { readonly stored: string; readonly text: string } | undefined,
  clock: Clock.Clock,
): {
  readonly entity: StoredEntity;
  readonly changed: boolean;
  readonly path?: string;
  readonly previousPath?: string;
} => {
  const handle = orm(db);
  const now = sampleNow(clock, OPERATION);

  const row = loadEntity(handle, prepared.target, 'target', OPERATION);
  if (row.revision !== prepared.revision) {
    return raise(new RevisionConflict({ current: row.revision }));
  }
  // Mentioning `active` at all is refused for anything but a project.
  if (prepared.active !== undefined && row.type !== 'project') {
    return raise(new InvalidInput({ field: 'active', reason: 'active_requires_project' }));
  }
  requireActive(handle, row, 'target', OPERATION);

  // Computed before the write, as a move does, so a slug change can say where the item was.
  const previousPath = prepared.includePaths ? pathOf(handle, row, OPERATION) : undefined;
  const paths = (path: string | undefined) =>
    previousPath === undefined || path === undefined ? {} : { path, previousPath };
  if (!differsFromStored(prepared, content, row)) {
    return { entity: row, changed: false, ...paths(previousPath) };
  }

  try {
    handle
      .update(nodes)
      .set({
        ...(prepared.title === undefined ? {} : { title: prepared.title }),
        ...(prepared.description === undefined ? {} : { description: prepared.description }),
        ...(prepared.slug === undefined ? {} : { slug: prepared.slug }),
        ...(prepared.tags === undefined ? {} : { tags: JSON.stringify(prepared.tags) }),
        ...(prepared.active === undefined ? {} : { active: prepared.active ? 1 : 0 }),
        ...(content === undefined ? {} : { body: content.stored, bodyText: content.text }),
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(nodes.id, row.id))
      .run();
  } catch (cause) {
    // Only a supplied slug can make a unique violation an address clash.
    return raise(
      classifyFailure(
        {
          operation: OPERATION,
          stage: 'write',
          ...(prepared.slug === undefined ? {} : { slug: prepared.slug, parentId: row.parentId }),
        },
        cause,
      ),
    );
  }

  const written = loadEntity(handle, { id: row.id }, 'target', OPERATION);
  return {
    entity: written,
    changed: true,
    ...paths(prepared.includePaths ? pathOf(handle, written, OPERATION) : undefined),
  };
};

/** Whether any submitted value differs from the stored one. Tags compare as their stored JSON. */
const differsFromStored = (
  prepared: PreparedUpdate,
  content: { readonly stored: string } | undefined,
  row: StoredEntity,
): boolean =>
  (prepared.title !== undefined && prepared.title !== row.title) ||
  (prepared.description !== undefined && prepared.description !== row.description) ||
  (prepared.slug !== undefined && prepared.slug !== row.slug) ||
  (prepared.tags !== undefined && JSON.stringify(prepared.tags) !== row.tags) ||
  (prepared.active !== undefined && (prepared.active ? 1 : 0) !== row.active) ||
  (content !== undefined && content.stored !== row.body);
