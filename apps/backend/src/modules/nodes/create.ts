import type { CanonicalDocument } from '@raphael/content';
import { fromMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument } from '@raphael/content/schema';
import {
  decodeCreateRequest,
  decodeCreateResponse,
  type CreateResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { CREATE_FIELDS, invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, UnsupportedContent, type NodeError } from './errors.ts';
import {
  fingerprintOf,
  prepareCreate,
  type PreparedBody,
  type PreparedCreate,
} from './fingerprint.ts';
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

const OPERATION = 'nodes.create';

/**
 * Creating one container.
 *
 * The order of the pipeline is the design, so it is worth stating plainly:
 *
 * ```text
 * decode → normalize and detach → fingerprint
 *   → preliminary replay lookup      (a settled key answers before anything expensive happens)
 *   → convert content                (outside the transaction: it is the slow part, and it can fail)
 *   → immediate write transaction
 *       resample the clock
 *       authoritative replay recheck
 *       validate the parent, insert the node
 *       assemble and validate the response
 *       record the replay result
 *     commit
 * ```
 *
 * Two placements carry real weight. The replay lookup precedes conversion, so a historical success never
 * depends on the current parser still accepting the body that produced it - a document accepted last
 * week replays today even if the vocabulary has since narrowed. And the response is validated *before*
 * the commit, so a projection bug cannot leave a committed entity behind an error telling the caller
 * their request failed.
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

      const document = yield* convertBody(prepared.body);

      // Projecting the response body is the expensive part of the operation, so it happens here rather
      // than inside the transaction - and inside a typed channel, so a serializer fault is an internal
      // failure rather than a defect escaping the operation's declared error type.
      const { body, storedBody } = yield* Effect.try({
        try: () => ({
          body: bodyProjection(document, prepared.format),
          storedBody: JSON.stringify(document),
        }),
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'body projection' }, cause),
      });

      return yield* Effect.try({
        try: () =>
          writeTransaction(db, () =>
            commit(db, { prepared, fingerprint, storedBody, body, clock }),
          ),
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'write', slug: prepared.slug }, cause),
      });
    }),
  );

/**
 * Submitted content becomes canonical content here, outside any transaction.
 *
 * An omitted body and an explicitly empty Markdown body both arrive here as empty Markdown, which the
 * converter turns into the canonical empty document - the same document the seed migration writes. There
 * is deliberately no separate fast path for it: a second way to produce "empty" would be a second thing
 * that could drift from what the converter does.
 */
const convertBody = (body: PreparedBody): Effect.Effect<CanonicalDocument, NodeError, never> =>
  Effect.try({
    // The conversion runs inside the Effect rather than while building it. Content failures are values
    // the converter returns, but a parser or canonicalizer *exception* is not - and outside a typed
    // channel it would surface as a defect rather than as the internal failure this operation promises.
    try: () =>
      body.format === 'markdown' ? fromMarkdown(body.value) : canonicalizeDocument(body.value),
    catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'content conversion' }, cause),
  }).pipe(
    Effect.flatMap((converted) =>
      Either.isRight(converted)
        ? Effect.succeed(converted.right)
        : Effect.fail(new UnsupportedContent({ failure: converted.left })),
    ),
  );

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
    readonly fingerprint: string;
    readonly storedBody: string;
    readonly body: ReturnType<typeof bodyProjection>;
    readonly clock: Clock.Clock;
  },
): CreateResponse => {
  const { prepared, fingerprint, storedBody, body } = context;
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
  validateParentage(scope, prepared.type);
  const parent = scope.kind === 'root' ? undefined : scope.node;

  const inserted = handle
    .insert(nodes)
    .values({
      type: prepared.type,
      parentId: parent === undefined ? null : parent.id,
      parentType: parent === undefined ? null : parent.type,
      slug: prepared.slug,
      revision: 1,
      title: prepared.title,
      description: prepared.description,
      body: storedBody,
      tags: JSON.stringify(prepared.tags),
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
        parentId: parent === undefined ? null : parent.id,
        slug: prepared.slug,
        revision: 1,
        title: prepared.title,
        description: prepared.description,
        tags: prepared.tags,
        body,
        metadata: prepared.metadata,
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
