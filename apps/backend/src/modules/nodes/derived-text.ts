import { isDeepStrictEqual } from 'node:util';

import { canonicalizeDocument, deriveText } from '@raphael/content/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { Db } from '../../infrastructure/database/layer.ts';
import { yieldToEventLoop } from './scheduling.ts';
import { nodes } from './schema.ts';
import { orm, readTransaction, writeTransaction } from './store.ts';

/**
 * Filling in missing plain-text projections.
 *
 * Every node created since `0002` writes its `body_text` in the same transaction as the row, so this
 * pass exists for rows that predate the column - today, the two root areas the bootstrap migration
 * seeds, and any future row a migration inserts without deriving a projection for it. It is deliberately
 * not a general maintenance framework: one query, one conditional write, no configuration key, no
 * completion ledger. `body_text IS NULL` *is* the state, so a pass that is interrupted resumes on the
 * next start by asking the same question.
 *
 * The null is load-bearing and is why this cannot be a blanket `UPDATE ... SET body_text = ''`. Null
 * means "no projection has been derived for this row"; the empty string means "this row's body was read
 * and its text is empty". Writing the second without doing the first would assert a fact about content
 * nothing had looked at, and a row whose body is corrupt would be recorded as successfully empty.
 *
 * Four properties are load-bearing.
 *
 * **A cursor that advances past failures.** The cursor moves to the last examined id whether or not that
 * row was written, so a permanently invalid row is a step forward rather than a loop. Selecting only
 * null projections without a cursor would re-read the same unwritable row forever.
 *
 * **A conditional write guarded by revision.** `WHERE id = ? AND revision = ? AND body_text IS NULL`
 * means the write applies only to the version that was actually inspected. A concurrent creation, or a
 * future authored update, cannot be overwritten by a derivation taken from an older body. Zero changed
 * rows is an ordinary outcome, not a failure.
 *
 * **Row failure and storage failure are different.** A body that will not parse or canonicalize is that
 * row's problem: it is reported, skipped, and left null, and the pass continues. Storage refusing to
 * answer is the pass's problem: it stops. Neither ever stops the listener.
 *
 * **Nothing is repaired.** A body that fails its integrity check keeps its stored form and its revision.
 * This pass adds a missing projection; it is not a content fixer, and a read path that reports corruption
 * must keep reporting it.
 */

export const DERIVED_TEXT_BATCH_SIZE = 200;

export interface BackfillOutcome {
  readonly examined: number;
  readonly written: number;
  readonly skipped: number;
}

/** Where a row was abandoned. Never carries body text - only the identity and the stage. */
export type SkipStage = 'parse' | 'canonicalize' | 'not_canonical';

interface Candidate {
  readonly id: number;
  readonly revision: number;
  readonly body: string;
}

/**
 * Derives one row's text, or says where it gave up.
 *
 * The same canonicalization boundary the read path uses, in a form that returns a failure rather than
 * raising one: a corrupt row here is an expected finding to be counted, not an exception to be caught by
 * the loop that is supposed to keep going.
 */
const deriveFor = (
  body: string,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly stage: SkipStage } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, stage: 'parse' };
  }

  const canonical = canonicalizeDocument(parsed);
  if (Either.isLeft(canonical)) return { ok: false, stage: 'canonicalize' };

  // The same integrity test the read path applies: a body this capability wrote reproduces itself
  // exactly, so a mismatch means something we did not write is in the column. Deriving text from the
  // canonicalized form would publish a projection of content that is not what is stored.
  // Structural equality, matching the read path. Comparing serialized forms would call a row
  // non-canonical for nothing worse than a different key order.
  if (!isDeepStrictEqual(parsed, canonical.right)) {
    return { ok: false, stage: 'not_canonical' };
  }

  return { ok: true, text: deriveText(canonical.right) };
};

export const backfillDerivedText = (options: {
  readonly batchSize: number;
  readonly onRowSkipped: (detail: { readonly nodeId: number; readonly stage: SkipStage }) => void;
  readonly onComplete: (outcome: BackfillOutcome) => void;
  readonly onFailure: (detail: string) => void;
}): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const handle = orm(db);

    let cursor = 0;
    let examined = 0;
    let written = 0;
    let skipped = 0;

    for (;;) {
      const batch = yield* Effect.try({
        try: (): readonly Candidate[] =>
          readTransaction(db, () =>
            handle.all<Candidate>(
              sql`SELECT id, revision, body FROM nodes
                  WHERE body_text IS NULL AND id > ${cursor}
                  ORDER BY id LIMIT ${options.batchSize}`,
            ),
          ),
        catch: () => 'a derived-text batch could not be read',
      }).pipe(
        Effect.catchAll((detail) =>
          Effect.sync(() => {
            options.onFailure(detail);
            return undefined;
          }),
        ),
      );
      // A storage failure stops the pass and leaves the listener alone. It is not retried in a tight
      // loop: whatever is still null is retried on a later start, which is the same recovery the
      // interrupted case uses.
      if (batch === undefined) return;

      for (const row of batch) {
        examined += 1;
        cursor = row.id;

        const derived = deriveFor(row.body);
        if (!derived.ok) {
          skipped += 1;
          options.onRowSkipped({ nodeId: row.id, stage: derived.stage });
          continue;
        }

        const changed = yield* Effect.try({
          try: () =>
            writeTransaction(db, () =>
              handle
                .update(nodes)
                .set({ bodyText: derived.text })
                .where(
                  and(
                    eq(nodes.id, row.id),
                    eq(nodes.revision, row.revision),
                    isNull(nodes.bodyText),
                  ),
                )
                .run(),
            ).changes,
          catch: () => 'a derived-text row could not be written',
        }).pipe(
          Effect.catchAll((detail) =>
            Effect.sync(() => {
              options.onFailure(detail);
              return undefined;
            }),
          ),
        );
        if (changed === undefined) return;
        if (changed > 0) written += 1;
      }

      // A short batch means there was nothing more to find.
      if (batch.length < options.batchSize) {
        options.onComplete({ examined, written, skipped });
        return;
      }

      yield* yieldToEventLoop;
    }
  });
