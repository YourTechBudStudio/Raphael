import type { CanonicalDocument } from '@raphael/content';
import { fromMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument } from '@raphael/content/schema';
import type { JsonObject } from '@raphael/contracts';
import { Effect, Either } from 'effect';

import { UnsupportedContent, type NodeError } from './errors.ts';
import { unwrapFailure } from './storage-failures.ts';

/** A submitted body, detached from the caller's value and still in the format it was submitted in. */
export type PreparedBody =
  | { readonly format: 'markdown'; readonly value: string }
  | { readonly format: 'tiptap'; readonly value: JsonObject };

/** Converts one submitted body to canonical content, outside any transaction. */
export const convertBody = (
  body: PreparedBody,
  operation: string,
): Effect.Effect<CanonicalDocument, NodeError, never> =>
  Effect.try({
    // A converter exception becomes an internal failure; content refusals come back as values.
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
