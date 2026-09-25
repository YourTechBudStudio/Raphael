import type { CanonicalDocument } from '@raphael/content';
import { deriveText } from '@raphael/content/schema';
import {
  decodeCreateRequest,
  decodeCreateResponse,
  type CreateResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { convertBody } from './content.ts';
import { CREATE_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, InvalidInput, type NodeError } from './errors.ts';
import {
  deriveSlugOrRaise,
  fingerprintOf,
  prepareCreate,
  type PreparedCreate,
} from './fingerprint.ts';
import { allowsOmittedTitle } from './kinds.ts';
import { requireActive } from './lifecycle.ts';
import { bodyProjection, checkedResponse } from './projection.ts';
import {
  REPLAY_TTL_MS,
  conflict,
  findReplay,
  recordReplay,
  replayDecision,
  savedResponse,
} from './replay.ts';
import { resolveScope, validateParentage } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, safeRowId, sampleNow, writeTransaction } from './store.ts';
import { resolveOmittedTitle } from './title.ts';

const OPERATION = 'nodes.create';

/**
 * Creating one node - a container, or a resource of a supported kind.
 *
 * The order of the pipeline is the design, so it is worth stating plainly:
 *
 * ```text
 * decode → normalize and detach → fingerprint
 *   → preliminary replay lookup      (a settled key answers before anything expensive happens)
 *   → convert content                (outside the transaction: it is the slow part, and it can fail)
 *   → resolve an omitted title       (needs the converted document; must follow the replay lookup)
 *   → derive plain body text         (mutation-time derivation, ADR 0005)
 *   → project the response body
 *   → immediate write transaction
 *       resample the clock
 *       authoritative replay recheck
 *       validate the parent, and require it to be active
 *       insert the node with its kind and derived text
 *       assemble and validate the response
 *       record the replay result
 *     commit
 * ```
 *
 * Three placements carry real weight. The replay lookup precedes conversion, so a historical success
 * never depends on the current parser still accepting the body that produced it - a document accepted
 * last week replays today even if the vocabulary has since narrowed. Title resolution sits after
 * conversion because it reads the canonical document, and after the replay lookup for the same reason
 * conversion does: a settled key must answer before any content work. And the response is validated
 * *before* the commit, so a projection bug cannot leave a committed entity behind an error telling the
 * caller their request failed.
 *
 * The replay recheck also precedes the parent's lifecycle check. A retried key whose parent was
 * archived after the original creation answers with the saved historical success, lifecycle fields
 * included, because that is a truthful statement about the original request (ADR 0002). A caller that
 * needs the entity's status now reads it with Get.
 *
 * The consequence of that first placement is deliberate and observable: a retry whose input differs
 * conflicts on the key even when conversion would also have rejected its body. The key is the more
 * specific answer, and it is the one that tells the caller what to actually do.
 */
export const createNode = (input: unknown): Effect.Effect<CreateResponse, NodeError, Db> =>
  Effect.clockWith((clock) =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Decoding, normalization, detachment, and fingerprinting are one synchronous step. Keeping them
      // together is what makes "the request is unchanged from fingerprinting onward" true by
      // construction, and it keeps the serializer's own guard inside a typed failure channel rather than
      // letting it escape as a defect.
      const { prepared, fingerprint } = yield* Effect.try({
        try: () => {
          const request = decodeCreateRequest(input);
          if (Either.isLeft(request)) {
            return raise(invalidInputFrom(request.left, CREATE_FIELDS, input));
          }
          const normalized = prepareCreate(request.right);
          return { prepared: normalized, fingerprint: fingerprintOf(normalized) };
        },
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'request preparation' }, cause),
      });

      // A single statement needs no explicit transaction: it is its own. The authoritative check happens
      // again inside the write transaction, where the decision is the one that counts.
      const settled = yield* Effect.try({
        try: () => {
          const key = prepared.idempotencyKey;
          if (key === undefined) return undefined;
          const now = sampleNow(clock, OPERATION);
          const decision = replayDecision(findReplay(orm(db), key), fingerprint, now);
          if (decision.kind === 'replay') return savedResponse(decision.row, OPERATION);
          if (decision.kind === 'conflict') return conflict();
          return undefined;
        },
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'replay lookup' }, cause),
      });
      if (settled !== undefined) return settled;

      const document = yield* convertBody(prepared.body, OPERATION);

      // Resolving the title can raise `InvalidInput`, so it shares the typed channel with the two
      // derivations that follow it.
      const named = yield* Effect.try({
        try: () => resolveAddress(prepared, document),
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'title resolution' }, cause),
      });

      // Projecting the response body is the expensive part of the operation, so it happens here rather
      // than inside the transaction - and inside a typed channel, so a serializer fault is an internal
      // failure rather than a defect escaping the operation's declared error type.
      //
      // `deriveText` runs on an already-validated document and is total, so a raise from it is an
      // internal failure rather than something the caller submitted wrongly.
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
            commit(db, { prepared, named, fingerprint, storedBody, body, derivedText, clock }),
          ),
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'write', slug: named.slug }, cause),
      });
    }),
  );

/**
 * The name and address this node will be created under.
 *
 * A supplied title is already trimmed and its slug already derived, so this is a no-op for every
 * container and for any note that named itself. Everything below is the omitted-title case.
 *
 * The order is deliberate and is not a search for something that works. A candidate is chosen from
 * the content first, and only then is an address derived from it. If the chosen title cannot produce a
 * usable address, that is reported against the title - it does **not** fall through to the description
 * looking for a second candidate that might slug more conveniently. Falling through would mean the
 * note's name depended on whether its own first line happened to contain sluggable characters, which is
 * a rule nobody could predict from what they typed.
 *
 * An explicit slug with an omitted title keeps the caller's slug: only the name is derived.
 */
const resolveAddress = (
  prepared: PreparedCreate,
  document: CanonicalDocument,
): { readonly title: string; readonly slug: string } => {
  if (prepared.title !== undefined) {
    if (prepared.slug === undefined) {
      // Unreachable: a supplied title always derives its slug during preparation.
      return raise(
        new InternalFailure({ operation: OPERATION, detail: 'a titled request has no address' }),
      );
    }
    return { title: prepared.title, slug: prepared.slug };
  }

  // A container is never prepared without a title - `TitleInput` is mandatory in that union member -
  // so an untitled request here is a resource, and its kind decides whether omission was allowed.
  if (prepared.kind === undefined || !allowsOmittedTitle(prepared.kind)) {
    return raise(new InvalidInput({ field: 'title', reason: 'title_required' }));
  }

  const resolved = resolveOmittedTitle(document, prepared.description);
  if (resolved === undefined) {
    return raise(new InvalidInput({ field: 'title', reason: 'title_required' }));
  }

  return {
    title: resolved.title,
    slug: prepared.slug ?? deriveSlugOrRaise(resolved.title),
  };
};

/**
 * Everything that must be one atomic fact.
 *
 * The clock is sampled here rather than reused from the preliminary lookup: that reading was taken before
 * content conversion, which is unbounded work, and a stored timestamp should say when the row was
 * written. Both timestamps take the one sampled instant, because they describe one event.
 */
const commit = (
  db: Database.Database,
  context: {
    readonly prepared: PreparedCreate;
    readonly named: { readonly title: string; readonly slug: string };
    readonly fingerprint: string;
    readonly storedBody: string;
    readonly body: ReturnType<typeof bodyProjection>;
    readonly derivedText: string;
    readonly clock: Clock.Clock;
  },
): CreateResponse => {
  const { prepared, named, fingerprint, storedBody, body, derivedText } = context;
  const handle = orm(db);
  const now = sampleNow(context.clock, OPERATION);
  if (now > Number.MAX_SAFE_INTEGER - REPLAY_TTL_MS) {
    return raise(
      new InternalFailure({
        operation: OPERATION,
        detail: 'the sampled time leaves no room for a replay expiry',
      }),
    );
  }

  const key = prepared.idempotencyKey;
  let replaceExpired = false;
  if (key !== undefined) {
    const decision = replayDecision(findReplay(handle, key), fingerprint, now);
    if (decision.kind === 'replay') return savedResponse(decision.row, OPERATION);
    if (decision.kind === 'conflict') return conflict();
    replaceExpired = decision.kind === 'expired';
  }

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
      slug: named.slug,
      revision: 1,
      title: named.title,
      description: prepared.description,
      body: storedBody,
      // Every newly committed node carries a non-null projection, including the empty string for an
      // empty body. Null is reserved for a row that predates this column.
      bodyText: derivedText,
      tags: JSON.stringify(prepared.tags),
      // Stated rather than left to the column default, so the insert writes the same fact the
      // response below publishes. Every other field here is mirrored by the hand-assembled entity;
      // without this line those two would agree only by two separately-maintained defaults.
      active: 0,
      metadata: JSON.stringify(prepared.metadata),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const id = safeRowId(inserted.lastInsertRowid, OPERATION);
  const response = checkedResponse(
    decodeCreateResponse,
    {
      entity: {
        id,
        type: prepared.type,
        kind: prepared.kind ?? null,
        parentId: parent === undefined ? null : parent.id,
        slug: named.slug,
        revision: 1,
        title: named.title,
        description: prepared.description,
        tags: prepared.tags,
        // A project is created inactive, and selection is never a creation request field: the story
        // frames it as a deliberate act on an entity that already exists. This mirrors what the insert
        // above writes, and is stated here because the hand-assembled entity is validated against the
        // same response contract every other node response is.
        active: false,
        // Active by construction: creation requires an active parent, and a new node has no cause.
        archived: false,
        body,
        metadata: prepared.metadata,
        archiveCauses: [],
      },
    },
    OPERATION,
  );

  if (key !== undefined) {
    recordReplay(handle, {
      key,
      fingerprint,
      resultJson: JSON.stringify(response),
      now,
      replaceExpired,
    });
  }
  return response;
};
