import { isDeepStrictEqual } from 'node:util';

import { type CanonicalDocument } from '@raphael/content';
import { toMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument } from '@raphael/content/schema';
import type { Decoder } from '@raphael/contracts';
import type { BodyFormat } from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { InternalFailure } from './errors.ts';
import { raise } from './storage-failures.ts';
import { isExposedNodeType, type StoredEntity, type StoredSummary } from './types.ts';

/**
 * Building responses, and refusing to publish anything that is not exactly what was intended.
 *
 * Two rules hold everywhere in this module. Public fields are listed one by one, never spread from a
 * row: the stored row carries `created_at`, `updated_at`, and `parent_type`, none of which are part of
 * the wire contract, and response decoding tolerates unrecognized properties - so explicit selection,
 * not the decoder, is what keeps internal columns internal. And every assembled response then goes
 * through its own shared decoder before it leaves the capability, so a projection bug surfaces here
 * rather than as a client's parse error against data it cannot do anything about.
 */

/**
 * Validates a response against the contract it claims to satisfy.
 *
 * This is the same decoder an installed client uses, which is the point: if this fails, the response
 * was not one a conforming client could have read. The failure is internal - the caller asked for
 * something reasonable and we assembled it wrongly - and neither the value nor the decoder's issues
 * are carried into it, because both can contain stored note content.
 */
export const checkedResponse = <A>(decoder: Decoder<A>, value: unknown, operation: string): A => {
  const decoded = decoder(value);
  if (Either.isLeft(decoded)) {
    return raise(
      new InternalFailure({ operation, detail: 'the assembled response failed its own contract' }),
    );
  }
  return decoded.right;
};

/** Parses a stored JSON column. Unparseable stored JSON is corruption in data we wrote. */
const parseStored = (text: string, operation: string, column: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return raise(
      new InternalFailure({ operation, detail: `stored ${column} is not parseable JSON` }),
    );
  }
};

/**
 * Validates a stored body and returns it as a canonical document.
 *
 * The complete public canonicalization boundary is reused rather than a cheaper structural check,
 * because the cheaper checks are each incomplete: vocabulary validation does not enforce the
 * ProseMirror content model, and the JSON-safety and depth passes live on the other side of that same
 * boundary. Anything narrower would be a second, weaker validator with the authority of the first.
 *
 * Canonicalization is idempotent, so a body this capability wrote reproduces itself exactly; the
 * equality check is therefore a real integrity test rather than a formality. A mismatch is reported and
 * never repaired: silently rewriting stored content during a read would destroy the evidence of
 * whatever produced it.
 */
export const validatedStoredBody = (storedJson: string, operation: string): CanonicalDocument => {
  const stored = parseStored(storedJson, operation, 'body');
  const canonical = canonicalizeDocument(stored);
  if (Either.isLeft(canonical)) {
    return raise(
      new InternalFailure({
        operation,
        detail: `stored body is not valid canonical content (${canonical.left.reason})`,
      }),
    );
  }
  if (!isDeepStrictEqual(stored, canonical.right)) {
    return raise(
      new InternalFailure({ operation, detail: 'stored body is not in its canonical form' }),
    );
  }
  return canonical.right;
};

/** A body in the format the caller asked for. Storage is always canonical; this is the projection. */
export const bodyProjection = (
  document: CanonicalDocument,
  format: BodyFormat,
):
  | { readonly format: 'markdown'; readonly value: string }
  | {
      readonly format: 'tiptap';
      readonly value: CanonicalDocument;
    } =>
  format === 'markdown'
    ? { format: 'markdown', value: toMarkdown(document) }
    : { format: 'tiptap', value: document };

/** The type of a stored row, as a type the operations may return. */
const exposedType = (type: string, operation: string): 'area' | 'project' => {
  if (!isExposedNodeType(type)) {
    return raise(
      new InternalFailure({ operation, detail: 'a projected row carries an unexposed type' }),
    );
  }
  return type;
};

/** The summary fields, every one of them named. */
export const summaryProjection = (row: StoredSummary, operation: string): unknown => ({
  id: row.id,
  type: exposedType(row.type, operation),
  parentId: row.parentId,
  slug: row.slug,
  revision: row.revision,
  title: row.title,
  description: row.description,
  tags: parseStored(row.tags, operation, 'tags'),
});

/**
 * The entity fields. `tags` and `metadata` are parsed but not otherwise inspected here: SQLite
 * guarantees only that they are a JSON array and a JSON object, so whether every tag is a string is
 * settled by the response decoder that runs over the assembled result.
 */
export const entityProjection = (
  row: StoredEntity,
  body: ReturnType<typeof bodyProjection>,
  operation: string,
): unknown => ({
  ...(summaryProjection(row, operation) as Record<string, unknown>),
  body,
  metadata: parseStored(row.metadata, operation, 'metadata'),
});
