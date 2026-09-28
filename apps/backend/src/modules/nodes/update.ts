import { deriveText } from '@raphael/content/schema';
import type { JsonObject } from '@raphael/contracts';
import {
  decodeUpdateRequest,
  decodeUpdateResponse,
  type BodyFormat,
  type UpdateRequest,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import type Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Either, type Clock } from 'effect';

import { Db } from '../../infrastructure/database/index.ts';
import { convertBody, type PreparedBody } from './content.ts';
import { invalidInputFrom } from './diagnostics.ts';
import { InternalFailure, InvalidInput, RevisionConflict, type NodeError } from './errors.ts';
import { requireActive } from './lifecycle.ts';
import {
  bodyProjection,
  checkedResponse,
  entityProjection,
  favoriteExpression,
  validatedStoredBody,
} from './projection.ts';
import { loadEntity, type Selector } from './resolve.ts';
import { nodes } from './schema.ts';
import { raise, unwrapFailure } from './storage-failures.ts';
import { orm, readTransaction, sampleNow, writeTransaction } from './store.ts';
import type { StoredEntity } from './types.ts';

const OPERATION = 'nodes.update';

/**
 * Changing one entity, against the revision the caller last read.
 *
 * ```text
 * decode → normalize and detach
 *   → deferred read transaction
 *       resolve the target, load the row
 *       require the row to be at the caller's revision   (a precondition, not the verdict)
 *       require the target to be active                 (fail fast; not the verdict either)
 *   → convert content                (outside the transaction: the slow part, and it can fail)
 *   → project the response body      (and derive plain text, for a supplied body)
 *   → assemble and validate the response    (nothing in it depends on the write)
 *   → immediate write transaction
 *       sample the clock
 *       re-select the revision; require the caller's
 *       require the target to be active                 (this is the lifecycle verdict)
 *       one UPDATE guarded on the caller's revision
 *       re-read the favorite state                      (the one field the write must answer)
 *     commit
 * ```
 *
 * Conversion and Markdown projection stay outside any transaction for the reasons `create.ts` argues.
 * The response goes further than `create.ts` can: it is assembled and validated before the write
 * transaction opens at all, because unlike a creation - whose response carries a row id that does not
 * exist until the insert - an update publishes nothing the write produces. A projection bug therefore
 * fails before anything is written, rather than being written and rolled back, and the exclusive write
 * lock is never held across a full contract decode.
 *
 * **Two raise sites, one verdict.** The read step requires `row.revision === request.revision` before
 * anything is computed from that row, and the write transaction re-selects the revision and compares it
 * again. They are not redundant. The read-time check is a precondition on *response correctness*:
 * without it, a caller supplying a revision one ahead of the row could have the compare-and-set match a
 * row this operation never read, so the returned entity and the resulting tag list would describe a
 * state nobody inspected. The write-time check is the verdict for the case the read cannot see - the
 * row moving between the two transactions. Both produce the same `RevisionConflict` with the same
 * message, because to a caller they are the same fact: what you wrote against is not what is there.
 *
 * Every successful update is a write. Submitting a value equal to the stored one still increments the
 * revision and advances `updated_at`; the server never compares submitted content to stored content,
 * which would make it a second content-equality authority. Clients that care about revision churn diff
 * locally before they send.
 *
 * **Lifecycle is decided in the write transaction.** Something archived - by a cause of its own or
 * through a container above it - cannot be updated, and that includes selecting or deselecting a
 * project: the stored `active` is kept and returns to view on restore. The read step checks it after
 * the revision and `active_requires_project`, only so an archived target fails before its body is
 * converted. The verdict is the write transaction's own check, because the target's revision proves
 * nothing about its ancestors: a container above it can be archived between the two transactions
 * without this row changing. So the write transaction re-selects the revision first - a stale caller
 * still hears `revision_conflict` first - and then re-checks lifecycle against the current ancestry,
 * atomically with the `UPDATE` (ADR 0002).
 *
 * A title change never touches the slug: deriving an address from a title is a creation-only reflex
 * (ADR 0004), and re-deriving it here would silently move an entity someone else may have linked to.
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

      const row = yield* Effect.try({
        try: () =>
          readTransaction(db, () => {
            const handle = orm(db);
            const entity = loadEntity(handle, prepared.target, 'target', OPERATION);
            if (entity.revision !== prepared.revision) {
              return raise(new RevisionConflict({ current: entity.revision }));
            }
            // Only a project can be marked active, and the rule is on *presence*: mentioning the field
            // for an area or a resource is refused whatever value it carries, because the caller's
            // mistake is that the field does not apply to this target - which is the family
            // `InvalidInput` already names - and "what did `active: false` on an area mean?" has no
            // good answer.
            //
            // Three guards state this rule and they are deliberately not the same rule, because each
            // refuses what it is positioned to know. This one sees the caller's *intent*, so it
            // refuses the mention. `activeMatchesType` in the contracts sees a *state*, so it refuses
            // only `true` - `active: false` on an area from some other server is a truthful reading.
            // `nodes_active_valid` permits `0` on an area, because every non-project row is exactly
            // that. ADR 0007 is explicit that a constraint is not a substitute for core validation, so
            // this is the check that produces the refusal; the column CHECK is the independent backstop
            // against a write that never came through here.
            //
            // After the revision precondition, before any body conversion: a caller whose write is
            // already lost is told *that* first.
            if (prepared.active !== undefined && entity.type !== 'project') {
              return raise(
                new InvalidInput({ field: 'active', reason: 'active_requires_project' }),
              );
            }
            // Fail fast only: the write transaction's check is the verdict.
            requireActive(handle, entity, 'target', OPERATION);
            return entity;
          }),
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'read' }, cause),
      });

      // A stale revision is reported before any content is converted, so a caller whose write is
      // already lost is told *that* rather than being told their body was unacceptable.
      const converted =
        prepared.body === undefined ? undefined : yield* convertBody(prepared.body, OPERATION);

      const projected = yield* Effect.try({
        try: () => {
          // An omitted body still has to be read: the response carries the whole entity, so the stored
          // document is projected exactly as a Get would project it. Its integrity check is the same
          // one, which is why a corrupt row fails an unrelated title change rather than publishing a
          // body nothing validated.
          const document = converted ?? validatedStoredBody(row.body, OPERATION);
          return {
            body: bodyProjection(document, prepared.format),
            // `deriveText` runs on an already-validated document and is total, so a raise from it is an
            // internal failure rather than something the caller submitted wrongly.
            content:
              converted === undefined
                ? undefined
                : { storedBody: JSON.stringify(document), derivedText: deriveText(document) },
          };
        },
        catch: (cause) => unwrapFailure({ operation: OPERATION, stage: 'body projection' }, cause),
      });

      // `row.revision` and `prepared.revision` are equal here - the read step required it - so this is
      // also the caller's revision plus one. Taking it from the row is what makes the response describe
      // a state that was actually inspected.
      const nextRevision = row.revision + 1;

      // Assembled and validated *before* the write, not inside it.
      //
      // Nothing published here needs the write to have happened: `id`, `type`, `kind`, `parentId` and
      // `metadata` come from the row that was read, the three authored fields are the submitted value or
      // the stored one, `revision` is known, and the body was projected above. `updated_at` is not a wire
      // field. The exception is `isFavorite`, which is read again at commit: a favorite changes no
      // revision, so only the write transaction can say what it was at the moment of this write.
      // Creation cannot do this - its response carries a generated row id that does not exist
      // until the insert - and that difference is the whole reason the two operations are shaped
      // differently here rather than symmetrically.
      //
      // Doing it here is strictly stronger than doing it inside the transaction. A projection bug now
      // fails before anything is written at all, rather than being written and rolled back, and the
      // exclusive write lock is not held across a full contract decode - which, for the `tiptap` format
      // mobile asks for, is a depth- and value-bounded traversal of the whole document.
      const response = yield* Effect.try({
        try: () =>
          checkedResponse(
            decodeUpdateResponse,
            {
              entity: entityProjection(
                {
                  ...row,
                  title: prepared.title ?? row.title,
                  description: prepared.description ?? row.description,
                  slug: prepared.slug ?? row.slug,
                  revision: nextRevision,
                  tags: prepared.tags === undefined ? row.tags : JSON.stringify(prepared.tags),
                  // Still the stored integer shape, so `summaryProjection` stays the one place the
                  // conversion to a boolean happens.
                  active: prepared.active === undefined ? row.active : prepared.active ? 1 : 0,
                },
                projected.body,
                // Active by construction: the write below happens only after `requireActive` passes
                // inside its own transaction, so a published update always describes an active entity.
                [],
                OPERATION,
              ),
            },
            OPERATION,
          ),
        catch: (cause) =>
          unwrapFailure({ operation: OPERATION, stage: 'response projection' }, cause),
      });

      const isFavorite = yield* Effect.try({
        try: () =>
          writeTransaction(db, () =>
            commit(db, { prepared, row, content: projected.content, nextRevision, clock }),
          ),
        catch: (cause) =>
          // The slug context is passed only when a slug was supplied, so an unrelated unique violation
          // cannot be misreported as an address clash. Slug collisions need no other handling: the
          // `UPDATE` violates the same two partial unique indexes an insert does, and a row does not
          // conflict with its own index entry, so re-submitting an entity's current slug is accepted.
          unwrapFailure(
            {
              operation: OPERATION,
              stage: 'write',
              ...(prepared.slug === undefined ? {} : { slug: prepared.slug }),
            },
            cause,
          ),
      });

      // The one field the pre-assembled response cannot know: it is swapped in whole, and no contract
      // filter reads it, so the checked response stays valid.
      return { entity: { ...response.entity, isFavorite } };
    }),
  );

/**
 * The normalized update request.
 *
 * Every optional here is `undefined` exactly when the caller omitted the field, because the envelope's
 * optionals are `exact: true`. That is the whole of the omission-versus-clearing rule: an omitted
 * `description` leaves the column alone, while `description: ''` clears it, and the two are
 * distinguishable without a sentinel value or a separate list of fields to clear.
 */
interface PreparedUpdate {
  /** The selector as submitted, id or path. */
  readonly target: Selector;
  /** The revision the caller wrote against. */
  readonly revision: number;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly slug: string | undefined;
  readonly body: PreparedBody | undefined;
  /** The full resulting list, or `undefined` to keep the stored one. */
  readonly tags: readonly string[] | undefined;
  /** The desired resulting state, or `undefined` when the caller did not mention selection. */
  readonly active: boolean | undefined;
  readonly format: BodyFormat;
}

/**
 * Trims the title and detaches every pass-through value, exactly as creation does, so what is
 * validated is what is written.
 */
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
        ? { format: 'tiptap', value: structuredClone(request.body.value) as JsonObject }
        : { format: 'markdown', value: request.body.value },
  tags: request.tags === undefined ? undefined : [...request.tags],
  active: request.active,
  format: request.format,
});

/**
 * The verdict and the write, atomically.
 *
 * The response was assembled and validated before the transaction opened, because nothing in it
 * depends on the write. What is left is a clock sample, the revision verdict, the lifecycle verdict,
 * one guarded `UPDATE`, and the favorite state at commit, which is the answer.
 *
 * The revision is re-selected first. A mismatch is the ordinary outcome of two clients editing the same
 * entity, and reporting it before lifecycle keeps revision-first precedence. With the revision
 * confirmed unchanged, `row.parentId` is current - any move bumps the revision - so `requireActive`
 * judges the target's current ancestry. That closes the race an ancestor archived between the two
 * transactions would otherwise open.
 *
 * After those two checks nothing else can have changed the row inside this immediate transaction, so a
 * guard that matches nothing is our bug, as in `move.ts`. No operation removes rows (AC7), so a target
 * that vanished is one too.
 */
const commit = (
  db: Database.Database,
  context: {
    readonly prepared: PreparedUpdate;
    readonly row: StoredEntity;
    readonly content: { readonly storedBody: string; readonly derivedText: string } | undefined;
    readonly nextRevision: number;
    readonly clock: Clock.Clock;
  },
): boolean => {
  const { prepared, row, content, nextRevision } = context;
  const handle = orm(db);
  // A revision past the safe integer bound trips `nodes_revision_safe` and surfaces as an internal
  // failure through the storage classifier, which is the right classification for something that
  // cannot happen in practice.
  const now = sampleNow(context.clock, OPERATION);

  const current = handle
    .select({ revision: nodes.revision })
    .from(nodes)
    .where(eq(nodes.id, row.id))
    .get();
  if (current === undefined) {
    return raise(
      new InternalFailure({
        operation: OPERATION,
        detail: 'an update target vanished inside its own transaction',
      }),
    );
  }
  if (current.revision !== prepared.revision) {
    return raise(new RevisionConflict({ current: current.revision }));
  }
  requireActive(handle, row, 'target', OPERATION);

  const changed = handle
    .update(nodes)
    .set({
      ...(prepared.title === undefined ? {} : { title: prepared.title }),
      ...(prepared.description === undefined ? {} : { description: prepared.description }),
      ...(prepared.slug === undefined ? {} : { slug: prepared.slug }),
      ...(prepared.tags === undefined ? {} : { tags: JSON.stringify(prepared.tags) }),
      ...(prepared.active === undefined ? {} : { active: prepared.active ? 1 : 0 }),
      ...(content === undefined ? {} : { body: content.storedBody, bodyText: content.derivedText }),
      revision: nextRevision,
      updatedAt: now,
    })
    .where(and(eq(nodes.id, row.id), eq(nodes.revision, prepared.revision)))
    .run().changes;

  if (changed !== 1) {
    return raise(
      new InternalFailure({
        operation: OPERATION,
        detail: 'the guarded update matched no row inside its own transaction',
      }),
    );
  }

  // A favorite changes no revision, so the revision checks above cannot see one that changed between
  // the two transactions. Read it here instead, so the response describes the moment of this write.
  const favorite = handle.get<{ readonly isFavorite: number }>(
    sql`SELECT ${favoriteExpression(sql`${row.id}`)} AS isFavorite`,
  );
  return favorite?.isFavorite === 1;
};
