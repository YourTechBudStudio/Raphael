import { isDeepStrictEqual } from 'node:util';

import { type CanonicalDocument } from '@raphael/content';
import { toMarkdown } from '@raphael/content/conversion';
import { canonicalizeDocument } from '@raphael/content/schema';
import type { Decoder } from '@raphael/contracts';
import { RESOURCE_KINDS, type BodyFormat, type ResourceKind } from '@raphael/contracts/nodes';
import { sql, type SQL } from 'drizzle-orm';
import { Either } from 'effect';

import { InternalFailure } from './errors.ts';
import { raise } from './storage-failures.ts';
import {
  isNodeType,
  type EffectiveCause,
  type NodeType,
  type StoredEntity,
  type StoredSummary,
} from './types.ts';

/**
 * Building responses, and refusing to publish anything that is not exactly what was intended.
 *
 * Two rules hold everywhere in this module. Public fields are listed one by one, never spread from a
 * row: the stored row carries `created_at`, `updated_at`, `parent_type`, and `body_text`, none of which
 * are part of the wire contract, and response decoding tolerates unrecognized properties - so explicit selection,
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
export const parseStored = (text: string, operation: string, column: string): unknown => {
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

/** The type of a stored row, checked rather than assumed. */
const projectedType = (type: string, operation: string): NodeType => {
  if (!isNodeType(type)) {
    return raise(
      new InternalFailure({ operation, detail: 'a projected row carries an unrecognized type' }),
    );
  }
  return type;
};

/**
 * The kind of a stored row, enforcing the same invariant the storage constraint does - on the way out.
 *
 * A resource with a null or unrecognized kind, and a container carrying one, are both integrity
 * failures rather than responses. The constraint in `0002` is what prevents such a row being written;
 * this is what prevents one that got there anyway from being handed to a client as though it were
 * ordinary. A database that bypassed the constraint cannot produce a plausible response.
 */
const projectedKind = (
  type: NodeType,
  kind: string | null,
  operation: string,
): ResourceKind | null => {
  if (type !== 'resource') {
    if (kind !== null) {
      return raise(
        new InternalFailure({ operation, detail: 'a projected container carries a kind' }),
      );
    }
    return null;
  }
  if (kind === null || !(RESOURCE_KINDS as readonly string[]).includes(kind)) {
    return raise(
      new InternalFailure({ operation, detail: 'a projected resource carries no supported kind' }),
    );
  }
  return kind as ResourceKind;
};

/**
 * The columns a summary is read from, aliased as `StoredSummary` names them.
 *
 * Here rather than in either page operation, because this is the module that owns the "every field
 * named" rule and the `StoredSummary` shape they are read into. Two statements select these columns
 * and a third will; a column list copied per caller is a list that drifts. Naming them is also what
 * keeps a computed column - the relevance score a search selects beside them - off the wire, since
 * `summaryProjection` below reads only the fields it lists.
 */
export const SUMMARY_COLUMNS: SQL = sql`n.id AS id, n.type AS type, n.kind AS kind,
  n.parent_id AS parentId, n.slug AS slug, n.revision AS revision, n.title AS title,
  n.description AS description, n.tags AS tags, n.active AS active`;

/**
 * The summary fields, every one of them named.
 *
 * `archived` is a parameter rather than a column, and it has no default. Each caller states it: a page
 * computes it, Get and the lifecycle operations derive it from the causes they walked, and the
 * mutations that can only succeed on something active pass `false` with a comment naming the rule
 * that guarantees it. No call site can forget the field.
 */
export const summaryProjection = (
  row: StoredSummary,
  archived: boolean,
  operation: string,
): unknown => {
  const type = projectedType(row.type, operation);
  return {
    id: row.id,
    type,
    kind: projectedKind(type, row.kind, operation),
    parentId: row.parentId,
    slug: row.slug,
    revision: row.revision,
    title: row.title,
    description: row.description,
    tags: parseStored(row.tags, operation, 'tags'),
    // The single integer-to-boolean site. Deliberately unvalidated, unlike `projectedKind`: `kind`'s
    // vocabulary is open to drift, while `nodes_active_valid` closes this one to `0` and `1` and ties
    // `1` to a project, so there is no third value for a check here to catch.
    active: row.active === 1,
    archived,
  };
};

/** Archive causes as the wire names them, in the order given: nearest origin first. */
export const causeProjection = (causes: readonly EffectiveCause[]): unknown[] =>
  causes.map((cause) => ({
    origin: { id: cause.originId, type: cause.originType, title: cause.originTitle },
    owner: cause.owner,
    reason: cause.reason,
  }));

/**
 * The entity fields. `tags` and `metadata` are parsed but not otherwise inspected here: SQLite
 * guarantees only that they are a JSON array and a JSON object, so whether every tag is a string is
 * settled by the response decoder that runs over the assembled result.
 */
export const entityProjection = (
  row: StoredEntity,
  body: ReturnType<typeof bodyProjection>,
  causes: readonly EffectiveCause[],
  operation: string,
): unknown => ({
  ...(summaryProjection(row, causes.length > 0, operation) as Record<string, unknown>),
  body,
  metadata: parseStored(row.metadata, operation, 'metadata'),
  archiveCauses: causeProjection(causes),
});
