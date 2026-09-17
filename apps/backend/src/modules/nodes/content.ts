import type { CanonicalDocument } from '@raphael/content';
import { fromMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument } from '@raphael/content/schema';
import type { JsonObject } from '@raphael/contracts';
import { Effect, Either } from 'effect';

import { UnsupportedContent, type NodeError } from './errors.ts';
import { unwrapFailure } from './storage-failures.ts';

/**
 * Submitted content becoming canonical content, for every operation that accepts a body.
 *
 * This is a shared module rather than a helper inside creation because "empty body" must have exactly
 * one path. An omitted body on creation and an explicitly cleared body on update both arrive here as
 * empty Markdown, and the converter turns both into the canonical empty document - the same document
 * the seed migration writes. A second way to produce "empty" would be a second thing that could drift.
 *
 * The prepared shape lives here too, with the function that consumes it, rather than in the
 * creation-only fingerprint module it used to share a file with. Update has no fingerprint, so a
 * shared converter reaching into that module for its own parameter type would be a dependency on
 * creation's machinery for no reason beyond where the type happened to be written first.
 */

/**
 * A submitted body, detached from the caller's value and still in the format it was submitted in.
 *
 * Markdown stays Markdown and TipTap stays as submitted: creation fingerprints this value, and
 * fingerprinting a converted document would let one idempotency key silently cover two different asks.
 */
export type PreparedBody =
  | { readonly format: 'markdown'; readonly value: string }
  | { readonly format: 'tiptap'; readonly value: JsonObject };

/**
 * Converts one submitted body, outside any transaction.
 *
 * The `operation` is the caller's own name, so a conversion failure is diagnosed against the operation
 * that was actually running rather than against whichever one happened to define this function.
 */
export const convertBody = (
  body: PreparedBody,
  operation: string,
): Effect.Effect<CanonicalDocument, NodeError, never> =>
  Effect.try({
    // The conversion runs inside the Effect rather than while building it. Content failures are values
    // the converter returns, but a parser or canonicalizer *exception* is not - and outside a typed
    // channel it would surface as a defect rather than as the internal failure operations promise.
    try: () =>
      body.format === 'markdown' ? fromMarkdown(body.value) : canonicalizeDocument(body.value),
    catch: (cause) => unwrapFailure({ operation, stage: 'content conversion' }, cause),
  }).pipe(
    Effect.flatMap((converted) =>
      Either.isRight(converted)
        ? Effect.succeed(converted.right)
        : Effect.fail(new UnsupportedContent({ failure: converted.left })),
    ),
  );
