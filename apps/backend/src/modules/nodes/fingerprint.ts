import { createHash } from 'node:crypto';

import type { JsonObject } from '@raphael/contracts';
import {
  SLUG_MAX_CODE_POINTS,
  compareSlugBinary,
  deriveSlug,
  type BodyFormat,
  type CreateRequest,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { InternalFailure, InvalidInput } from './errors.ts';
import { raise } from './storage-failures.ts';
import type { NodeType } from './types.ts';

/**
 * The normalized creation request, and the fingerprint that decides whether a retry is the same
 * request.
 *
 * What is fingerprinted is the *request*, never the canonical document it converts to. Canonical
 * content is normalizing: two different submissions can converge on one stored body. Fingerprinting the
 * stored form would therefore let one idempotency key silently cover two different asks, which is the
 * opposite of what a key is for. Markdown stays Markdown here, submitted TipTap participates as it was
 * submitted, and the input format is part of the identity of the request.
 */

export type PreparedBody =
  | { readonly format: 'markdown'; readonly value: string }
  | { readonly format: 'tiptap'; readonly value: JsonObject };

export interface PreparedCreate {
  readonly type: NodeType;
  /** The selector *as submitted*: an id and a path are different requests even for the same parent. */
  readonly parent: { readonly id: number } | { readonly path: string };
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly body: PreparedBody;
  readonly tags: readonly string[];
  readonly metadata: JsonObject;
  readonly format: BodyFormat;
  readonly idempotencyKey: string | undefined;
}

/**
 * Normalizes a decoded request into the value everything downstream uses.
 *
 * Detachment happens here, and it happens *after* decoding rather than before. The decoder is what
 * bounds depth, total value count, and cycles, so cloning first would do unbounded structural work on
 * input nothing had yet inspected - and an internal caller is not behind the transport's byte budget.
 * Cloning after decoding copies values that are already known to be bounded.
 *
 * Only the pass-through positions need copying: the decoder returns fresh values for everything it
 * transforms, but `metadata` and an explicit TipTap `body.value` are handed through by reference, and
 * `tags` is copied rather than assumed to be. From this point the prepared request is not modified -
 * converted content is kept as a separate value - so what is fingerprinted is what is stored.
 */
export const prepareCreate = (request: CreateRequest): PreparedCreate => {
  const title = request.title.trim();
  const slug = explicitOrDerivedSlug(request.slug, title);

  const body: PreparedBody =
    request.body === undefined
      ? { format: 'markdown', value: '' }
      : request.body.format === 'tiptap'
        ? { format: 'tiptap', value: structuredClone(request.body.value) as JsonObject }
        : { format: 'markdown', value: request.body.value };

  return {
    type: request.type,
    parent: 'id' in request.parent ? { id: request.parent.id } : { path: request.parent.path },
    title,
    slug,
    description: request.description ?? '',
    body,
    tags: request.tags === undefined ? [] : [...request.tags],
    metadata:
      request.metadata === undefined ? {} : (structuredClone(request.metadata) as JsonObject),
    format: request.format,
    idempotencyKey: request.idempotencyKey,
  };
};

/**
 * An explicit slug is taken as given; otherwise one is derived from the trimmed title.
 *
 * A derivation failure is the caller's to fix by changing the title, so it names the title as the field
 * even though the slug is what could not be produced. Reporting the slug instead would ask someone to
 * correct a value they never submitted and, on mobile, cannot submit.
 */
const explicitOrDerivedSlug = (explicit: string | undefined, title: string): string => {
  if (explicit !== undefined) return explicit;
  const derived = deriveSlug(title);
  if (Either.isRight(derived)) return derived.right;
  return raise(
    new InvalidInput({
      field: 'title',
      reason: derived.left.reason,
      ...(derived.left.reason === 'slug_too_long' ? { limit: SLUG_MAX_CODE_POINTS } : {}),
    }),
  );
};

/**
 * Writes a value as deterministic JSON.
 *
 * The string is emitted directly instead of being built into an intermediate object and stringified.
 * That is not a micro-optimization: metadata is the caller's own namespace and may legitimately contain
 * a key like `__proto__`, and sorting keys into an ordinary object would assign it. There is no object
 * here to assign to, so the question does not arise.
 *
 * Anything JSON cannot represent is refused rather than given an invented encoding. The prepared
 * request has already passed the decoder's JSON-safety pass, so this is a guard against our own future
 * mistakes rather than a filter on caller input.
 */
const writeCanonicalJson = (value: unknown, out: string[]): void => {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) return refuse('a non-finite number');
      out.push(JSON.stringify(value));
      return;
    case 'string':
      // JSON.stringify performs the escaping; no string is ever interpolated into the output.
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      return refuse(`a ${typeof value} value`);
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (const [index, item] of value.entries()) {
      if (index > 0) out.push(',');
      writeCanonicalJson(item, out);
    }
    out.push(']');
    return;
  }

  const record = value as Record<string, unknown>;
  // Code point order. The requirement is determinism, and this is the comparison contracts already
  // exports for ordering slugs, so there is one implementation of it rather than two.
  const keys = Object.keys(record).sort(compareSlugBinary);
  out.push('{');
  for (const [index, key] of keys.entries()) {
    if (index > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    writeCanonicalJson(record[key], out);
  }
  out.push('}');
};

const refuse = (what: string): never =>
  raise(
    new InternalFailure({
      operation: 'nodes.create',
      detail: `the normalized request contained ${what}, which cannot be fingerprinted`,
    }),
  );

/**
 * The canonical form of a normalized request, and its fingerprint.
 *
 * The idempotency key is excluded - it identifies the attempt, not the request - and no timestamp or
 * generated identity participates, so the same request fingerprints identically whenever it is retried.
 * Applied defaults are materialized before this point, which is what makes an omitted field and an
 * explicitly-default one compare equal. The output format is included on purpose: a replay returns a
 * saved response rather than a fresh rendering, so asking for a different format is a different request.
 */
export const canonicalRequestJson = (prepared: PreparedCreate): string => {
  const out: string[] = [];
  writeCanonicalJson(
    {
      type: prepared.type,
      parent: prepared.parent,
      title: prepared.title,
      slug: prepared.slug,
      description: prepared.description,
      body: prepared.body,
      tags: prepared.tags,
      metadata: prepared.metadata,
      format: prepared.format,
    },
    out,
  );
  return out.join('');
};

export const fingerprintOf = (prepared: PreparedCreate): string =>
  createHash('sha256').update(canonicalRequestJson(prepared), 'utf8').digest('hex');
