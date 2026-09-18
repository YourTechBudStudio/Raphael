import { createHash } from 'node:crypto';

import type { JsonObject } from '@raphael/contracts';
import {
  SLUG_MAX_CODE_POINTS,
  compareSlugBinary,
  deriveSlug,
  type BodyFormat,
  type CreateRequest,
  type ResourceKind,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import type { PreparedBody } from './content.ts';
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

export interface PreparedCreate {
  readonly type: NodeType;
  /** Present exactly when `type` is `resource`. A container has no kind. */
  readonly kind: ResourceKind | undefined;
  /** The selector *as submitted*: an id and a path are different requests even for the same parent. */
  readonly parent: { readonly id: number } | { readonly path: string };
  /** Undefined only when a kind permits omission and the caller omitted it. */
  readonly title: string | undefined;
  /** Undefined only when neither a title nor a slug was supplied, so the address is not yet knowable. */
  readonly slug: string | undefined;
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
  const title = request.title === undefined ? undefined : request.title.trim();
  const slug = explicitOrDerivedSlug(request.slug, title);

  const body: PreparedBody =
    request.body === undefined
      ? { format: 'markdown', value: '' }
      : request.body.format === 'tiptap'
        ? { format: 'tiptap', value: structuredClone(request.body.value) as JsonObject }
        : { format: 'markdown', value: request.body.value };

  return {
    type: request.type,
    kind: request.type === 'resource' ? request.kind : undefined,
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
 * **An explicit slug is always kept, whether or not a title was supplied.** Only the derivation branch
 * can be deferred, and it is deferred in exactly one case: both the title and the slug were omitted, so
 * the address cannot be known until the title is resolved - which cannot happen before conversion,
 * which cannot happen before the replay lookup. `deriveSlugOrRaise` is what finishes the job later.
 *
 * This is what makes the CLI's path form fingerprint honestly. `raphael create resource.note
 * /work/api-design --body @-` splits into a parent path and the explicit slug `api-design`, so two such
 * requests at different addresses are two different requests under one key rather than one. Mobile is
 * the case that defers: it submits a parent id with no slug, so both are resolved from content.
 */
const explicitOrDerivedSlug = (
  explicit: string | undefined,
  title: string | undefined,
): string | undefined => {
  if (explicit !== undefined) return explicit;
  if (title === undefined) return undefined;
  return deriveSlugOrRaise(title);
};

/**
 * Derives an address from a title, or asks for a different title.
 *
 * A derivation failure is the caller's to fix by changing the title, so it names the title as the field
 * even though the slug is what could not be produced. Reporting the slug instead would ask someone to
 * correct a value they never submitted and, on mobile, cannot submit. This holds for a derived title
 * exactly as it does for an explicit one: if the text the note already carries cannot produce a usable
 * address, the answer is to ask for a title, never to invent an address the caller never saw.
 */
export const deriveSlugOrRaise = (title: string): string => {
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
 * generated identity participates. Neither does anything core derives: not the resolved title, not the
 * canonical document, not the plain-text projection. The request's identity remains the request, so a
 * retry is judged against what was asked rather than against what the server made of it.
 *
 * Nothing else about the canonical form changed, so the same request fingerprints identically whenever it is retried.
 * Applied defaults are materialized before this point, which is what makes an omitted field and an
 * explicitly-default one compare equal. The output format is included on purpose: a replay returns a
 * saved response rather than a fresh rendering, so asking for a different format is a different request.
 */
export const canonicalRequestJson = (prepared: PreparedCreate): string => {
  const out: string[] = [];
  writeCanonicalJson(
    {
      type: prepared.type,
      // Written only when defined, so an existing container fingerprint stays byte-identical rather
      // than changing spelling for a field containers do not have.
      ...(prepared.kind === undefined ? {} : { kind: prepared.kind }),
      parent: prepared.parent,
      // An omitted title and an unresolved slug are written as JSON `null` - a value no caller can
      // supply, since both are strings when present. That keeps them distinct from any submitted value
      // while leaving the two existing equalities intact: an explicit title with an omitted slug still
      // materializes its derived slug before this point, and an omitted title with an explicit slug
      // fingerprints that slug, so two such requests addressed differently never collide under one key.
      title: prepared.title ?? null,
      slug: prepared.slug ?? null,
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
