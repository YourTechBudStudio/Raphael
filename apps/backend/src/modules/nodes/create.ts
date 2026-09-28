import { deriveText } from '@raphael/content/schema';
import type { JsonObject } from '@raphael/contracts';
import {
  decodeCreateRequest,
  decodeCreateResponse,
  type CreateRequest,
  type CreateResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { convertBody, type PreparedBody } from './content.ts';
import { invalidInputFrom } from './diagnostics.ts';
import type { NodeError } from './errors.ts';
import { requireActive } from './lifecycle.ts';
import { bodyProjection, checkedResponse } from './projection.ts';
import { resolveScope, validateParentage } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, safeRowId, sampleNow, writeTransaction } from './store.ts';

const OPERATION = 'nodes.create';

/**
 * Creating one node - a container, or a resource of a supported kind - under the title and slug the
 * caller chose (ADR 0002). A sibling that already holds the slug is a `slug_conflict`, which is also
 * how a retry after a lost reply meets its own first attempt.
 *
 * Content conversion and the response body projection run before the write transaction, because they
 * are the slow part. The response is validated before the commit, so a projection bug cannot leave a
 * committed entity behind an error.
 */
export const createNode = (input: unknown): Effect.Effect<CreateResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      const prepared = yield* Effect.try({
        try: () => {
          const request = decodeCreateRequest(input);
          if (Either.isLeft(request)) return raise(invalidInputFrom(request.left, input));
          return prepareCreate(request.right);
        },
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'request preparation' }, cause),
      });

      const document = yield* convertBody(prepared.body, OPERATION);

      const { body, storedBody, derivedText } = yield* Effect.try({
        try: () => ({
          body: bodyProjection(document, prepared.format),
          storedBody: JSON.stringify(document),
          derivedText: deriveText(document),
        }),
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'body projection' }, cause),
      });

      return yield* Effect.try({
        try: () =>
          writeTransaction(db, () =>
            commit(db, { prepared, storedBody, body, derivedText, clock }),
          ),
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'write', slug: prepared.slug }, cause),
      });
    }),
  );

type PreparedCreate = ReturnType<typeof prepareCreate>;

/**
 * Trims the title and detaches `metadata`, which the decoder hands through by reference and which is
 * serialized only inside the write transaction. The body is converted before anything can yield, and
 * the tag schema already returns a fresh array.
 */
const prepareCreate = (request: CreateRequest) => {
  const body: PreparedBody =
    request.body === undefined
      ? { format: 'markdown', value: '' }
      : request.body.format === 'tiptap'
        ? { format: 'tiptap', value: request.body.value as JsonObject }
        : { format: 'markdown', value: request.body.value };
  return {
    type: request.type,
    kind: request.type === 'resource' ? request.kind : undefined,
    parent: request.parent,
    title: request.title.trim(),
    slug: request.slug,
    description: request.description ?? '',
    body,
    tags: request.tags ?? [],
    metadata:
      request.metadata === undefined ? {} : (structuredClone(request.metadata) as JsonObject),
    format: request.format,
  };
};

/** Both timestamps take one instant sampled inside the transaction, because they describe one event. */
const commit = (
  db: Database.Database,
  context: {
    readonly prepared: PreparedCreate;
    readonly storedBody: string;
    readonly body: ReturnType<typeof bodyProjection>;
    readonly derivedText: string;
    readonly clock: Clock.Clock;
  },
): CreateResponse => {
  const { prepared, storedBody, body, derivedText } = context;
  const handle = orm(db);
  const now = sampleNow(context.clock, OPERATION);

  const scope = resolveScope(handle, prepared.parent, 'parent', OPERATION);
  validateParentage(scope, prepared.type, 'parent');
  const parent = scope.kind === 'root' ? undefined : scope.node;
  requireActive(handle, parent ?? null, 'parent', OPERATION);

  const inserted = handle
    .insert(nodes)
    .values({
      type: prepared.type,
      kind: prepared.kind ?? null,
      parentId: parent === undefined ? null : parent.id,
      parentType: parent === undefined ? null : parent.type,
      slug: prepared.slug,
      revision: 1,
      title: prepared.title,
      description: prepared.description,
      body: storedBody,
      bodyText: derivedText,
      tags: JSON.stringify(prepared.tags),
      active: 0,
      metadata: JSON.stringify(prepared.metadata),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const id = safeRowId(inserted.lastInsertRowid, OPERATION);
  return checkedResponse(
    decodeCreateResponse,
    {
      entity: {
        id,
        type: prepared.type,
        kind: prepared.kind ?? null,
        parentId: parent === undefined ? null : parent.id,
        slug: prepared.slug,
        revision: 1,
        title: prepared.title,
        description: prepared.description,
        tags: prepared.tags,
        // A new project is inactive, active by construction (its parent is active and it has no
        // cause), and not a favorite (a favorite references an existing id).
        active: false,
        archived: false,
        isFavorite: false,
        body,
        metadata: prepared.metadata,
        archiveCauses: [],
      },
    },
    OPERATION,
  );
};
