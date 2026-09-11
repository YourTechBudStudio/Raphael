/**
 * Recovery details: the part of an error envelope a client may show a person.
 *
 * `details` is typed as a safe JSON object, which establishes that it survives a round trip and is
 * bounded. It establishes nothing about confidentiality, terminal safety, or meaning. A client is
 * talking to a self-hosted server it does not control, upgraded independently of itself, possibly
 * behind a proxy - so a recognized error code does not constrain what properties arrive beside it.
 *
 * This module is the one place that decides which properties survive into user-facing output. It is
 * organized per error code rather than as one flat allowlist, because a property name means different
 * things under different codes and a name alone was never the safety property. Every value is
 * validated; nothing is repaired; unknown properties and unusable values are dropped without
 * rejecting an otherwise valid envelope.
 *
 * Two distinctions this module exists to keep apart:
 *
 * **Preservation is not interpretation.** A well-formed but unfamiliar `reason` survives into output,
 * because a client that dropped it would lose information the moment the server added a reason - the
 * same additive-compatibility argument that makes response decoding tolerant of unknown properties
 * and makes the error envelope accept unknown codes. But only explicitly recognized values may drive
 * tailored recovery wording or a certainty claim. An identifier-shaped string is not an instruction.
 *
 * **Validated is not non-sensitive.** `slug` is the caller's own submitted address and `element` is a
 * node name from the caller's own submitted document. Returning them to that caller is what makes the
 * failure actionable. Forwarding them to logs, telemetry, or any third party is a separate decision
 * this validation does not license.
 *
 * Layering: this sits above `shared/` and `nodes/` and is imported by neither, so adding it creates no
 * cycle through the error module.
 */

import { isRequestField, type RequestField } from './nodes/fields.ts';
import { SLUG_MAX_CODE_POINTS, isCanonicalSlugShape } from './nodes/slug.ts';
import type { ApiErrorCode } from './shared/errors.ts';
import { codePointLength, type JsonObject, type JsonValue } from './shared/json.ts';

/**
 * A lowercase machine identifier. Server-authored vocabularies - failure reasons, stored type names -
 * take this shape, and a newer server may add values this client has never heard of.
 *
 * The bound is what makes an unfamiliar value safe to render: no control characters, no escape
 * sequences, no whitespace, no direction-changing marks, and a length a terminal or a label can hold.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A document element name. Deliberately *not* `IDENTIFIER`: TipTap node and mark names are camelCase
 * (`codeBlock`, `horizontalRule`, `bulletList`), so the lowercase rule would silently discard exactly
 * the value that tells someone which element of their document was refused.
 *
 * This is the one projected string that can originate in a caller's submitted document rather than in
 * a server vocabulary. Our own content package already declines to reflect an unrecognized element
 * name, on the correct ground that matching a pattern is not a privacy argument - but a client cannot
 * assume the server it is talking to made that choice, so the value is bounded here and treated as
 * caller-owned data on the way out.
 */
const ELEMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** HTTP methods, as an `Allow` header spells them. */
const METHOD_LIST = /^[A-Z]{3,10}(?:, [A-Z]{3,10}){0,9}$/;

/** A document location is a diagnostic, not an address; a long one is malformed rather than deep. */
const PATH_MAX_SEGMENTS = 32;

/**
 * The `storage_busy` reason that means the server was shutting down and applied nothing.
 *
 * Exported because it is the one reason value a client is allowed to act on rather than merely
 * display, and a comparison that consequential should not be a string literal typed twice.
 */
export const SHUTTING_DOWN_REASON = 'shutting_down';

/**
 * Every property this module can produce. All optional: a valid envelope carrying no usable detail
 * projects to an empty object, which is an ordinary outcome and not a failure.
 */
export interface RecoveryDetails {
  /** Which request field the failure is about. Absent means the request as a whole. */
  readonly field?: RequestField;
  /** Preserved for display. Only recognized values may drive behavior. */
  readonly reason?: string;
  /** The bound that was exceeded. */
  readonly limit?: number;
  readonly nodeType?: string;
  readonly parentType?: string;
  readonly childType?: string;
  /** The caller's own submitted address. */
  readonly slug?: string;
  readonly scope?: 'root' | 'sibling';
  /** Child indices from the document root to the offending element. */
  readonly path?: readonly number[];
  /** An element name from the caller's own submitted document. */
  readonly element?: string;
  /** The methods an address accepts, as sent in `Allow`. */
  readonly allow?: string;
}

const asString = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const identifier = (value: JsonValue | undefined): string | undefined => {
  const text = asString(value);
  return text !== undefined && IDENTIFIER.test(text) ? text : undefined;
};

const elementName = (value: JsonValue | undefined): string | undefined => {
  const text = asString(value);
  return text !== undefined && ELEMENT_NAME.test(text) ? text : undefined;
};

const methodList = (value: JsonValue | undefined): string | undefined => {
  const text = asString(value);
  return text !== undefined && METHOD_LIST.test(text) ? text : undefined;
};

const requestField = (value: JsonValue | undefined): RequestField | undefined => {
  const text = asString(value);
  if (text === undefined) return undefined;
  return isRequestField(text) ? text : undefined;
};

/**
 * A slug is validated against the canonical grammar rather than a character bound, because an address
 * that could not be submitted cannot honestly describe what conflicted. The submission length bound
 * applies too: this value is only useful as something the person can retype.
 */
const slugValue = (value: JsonValue | undefined): string | undefined => {
  const text = asString(value);
  if (text === undefined) return undefined;
  if (!isCanonicalSlugShape(text)) return undefined;
  return codePointLength(text) <= SLUG_MAX_CODE_POINTS ? text : undefined;
};

const scopeValue = (value: JsonValue | undefined): 'root' | 'sibling' | undefined =>
  value === 'root' || value === 'sibling' ? value : undefined;

const safeCount = (value: JsonValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const indexPath = (value: JsonValue | undefined): readonly number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (value.length > PATH_MAX_SEGMENTS) return undefined;
  const segments: number[] = [];
  for (const segment of value) {
    const index = safeCount(segment);
    // One unusable segment makes the whole location meaningless: a partial path would point somewhere
    // the failure never happened, which is worse than reporting no location at all.
    if (index === undefined) return undefined;
    segments.push(index);
  }
  return segments;
};

/**
 * What a per-code validator assembles before the unusable values are removed. Distinct from
 * `RecoveryDetails` because a validator returns `undefined` for a property it rejected, while a
 * projected result carries only properties that are actually present.
 */
type Draft = { readonly [K in keyof RecoveryDetails]: RecoveryDetails[K] | undefined };

/** Drops the properties that validated to nothing, so an empty result is genuinely empty. */
const present = (projected: Draft): RecoveryDetails => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projected)) {
    if (value !== undefined) result[key] = value;
  }
  return result as RecoveryDetails;
};

/**
 * Project the details of one error envelope.
 *
 * An unrecognized code projects to nothing: there is no validator for a code this release has never
 * heard of, and guessing which properties a future code carries is exactly the spread this module
 * exists to avoid. The code and message still reach the caller through the classified error.
 */
export const projectRecoveryDetails = (code: string, details: JsonObject): RecoveryDetails => {
  const read = (key: string): JsonValue | undefined =>
    Object.hasOwn(details, key) ? details[key] : undefined;

  switch (code as ApiErrorCode) {
    case 'invalid_input':
      return present({
        field: requestField(read('field')),
        reason: identifier(read('reason')),
        limit: safeCount(read('limit')),
        nodeType: identifier(read('nodeType')),
      });
    case 'node_not_found':
      return present({ field: requestField(read('field')) });
    case 'invalid_parent':
      return present({
        field: requestField(read('field')),
        parentType: identifier(read('parentType')),
        childType: identifier(read('childType')),
      });
    case 'slug_conflict':
      return present({
        field: requestField(read('field')),
        slug: slugValue(read('slug')),
        scope: scopeValue(read('scope')),
      });
    case 'idempotency_conflict':
      return present({
        field: requestField(read('field')),
        reason: identifier(read('reason')),
      });
    case 'unsupported_content':
      return present({
        field: requestField(read('field')),
        reason: identifier(read('reason')),
        path: indexPath(read('path')),
        element: elementName(read('element')),
        limit: safeCount(read('limit')),
      });
    case 'payload_too_large':
      return present({ limit: safeCount(read('limit')) });
    case 'method_not_allowed':
      return present({ allow: methodList(read('allow')) });
    case 'unsupported_media_type':
      return present({ reason: identifier(read('reason')) });
    case 'storage_busy':
      return present({ reason: identifier(read('reason')) });
    case 'unauthorized':
    case 'route_not_found':
    case 'internal_error':
      return {};
    default:
      return {};
  }
};
