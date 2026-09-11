import { Schema } from 'effect';

import {
  JsonObjectSafe,
  codePointLength,
  describeJsonRejection,
  inspectJsonValue,
  isJsonObject,
  utf8ByteLength,
  type JsonObject,
  type JsonTraversalLimits,
} from '../shared/json.ts';
import { JSON_SAFETY_MAX_VALUES } from '../shared/limits.ts';
import { NonNegativeSafeInt, PositiveSafeInt } from '../shared/numbers.ts';
import { SLUG_MAX_CODE_POINTS, isCanonicalSlug } from './slug.ts';

/**
 * Product input limits for authored node fields. These bound what a caller may submit; they are not
 * applied when decoding a response, because a value the server already accepted and stored must not
 * become undecodable to a client whose own creation limits are older. Responses are still checked for
 * structure, invariants, and supported discriminants.
 *
 * Lengths count Unicode code points. Byte budgets count UTF-8 bytes.
 */
export const TITLE_MAX_CODE_POINTS = 200;
export const DESCRIPTION_MAX_CODE_POINTS = 4_000;
export const TAGS_MAX_COUNT = 25;
export const TAG_MIN_CODE_POINTS = 1;
export const TAG_MAX_CODE_POINTS = 50;
export const METADATA_MAX_TOP_LEVEL_KEYS = 50;
export const METADATA_MAX_DEPTH = 5;
export const METADATA_MAX_KEY_CODE_POINTS = 100;
export const METADATA_MAX_SERIALIZED_BYTES = 16_384;
export const IDEMPOTENCY_KEY_MAX_CODE_POINTS = 200;

/**
 * Document bounds. Depth is enforced here because it is structural and cheap. The authoritative
 * node-count limit belongs to the content package, which knows what a document node actually is;
 * counting JSON values is not the same measurement, so this release bounds transport work with its
 * own explicit ceiling and leaves `DOCUMENT_MAX_NODES` to be enforced where documents are understood.
 */
export const DOCUMENT_MAX_DEPTH = 64;
export const DOCUMENT_MAX_NODES = 10_000;
export const DOCUMENT_TRANSPORT_MAX_JSON_VALUES = 100_000;

export const LIST_SKIP_DEFAULT = 0;
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 500;

export { SLUG_MAX_CODE_POINTS };

export const NodeId = PositiveSafeInt;
export const NodeRevision = PositiveSafeInt;

/** The node types this release's operations accept and return. */
export const NODE_TYPES = ['area', 'project'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const NodeTypeSchema = Schema.Literal(...NODE_TYPES);

export const BODY_FORMATS = ['markdown', 'tiptap'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];
export const BodyFormatSchema = Schema.Literal(...BODY_FORMATS);

export type TitleRejectionReason =
  /**
   * Present but not a string. Callers present this as an ordinary invalid field rather than as title
   * guidance, because "a title is required" is the wrong advice for someone who submitted a number.
   */
  | 'not_string'
  /** Absent, empty, or whitespace only. */
  | 'title_required'
  /** Longer than the limit once trimmed. */
  | 'title_too_long';

export interface TitleRejection {
  readonly reason: TitleRejectionReason;
  /** The bound that was exceeded, when the reason is a limit. */
  readonly limit?: number;
}

/**
 * Inspects a submitted title and names what is wrong with it, without repeating the value.
 *
 * This exists so the schema refinement and the server's own diagnostics apply one title policy rather
 * than two. A decoder's formatted message can carry the submitted value, so the server cannot forward
 * one; it re-inspects the field through this helper and reports only the reason and limit returned
 * here. Length is measured on the trimmed value because core trims before saving, so rejecting on the
 * untrimmed length would reject a title that is going to fit.
 */
export const inspectTitleInput = (input: unknown): TitleRejection | undefined => {
  // `undefined` means the property was absent, which JSON cannot otherwise express: a parsed payload
  // never holds an explicit `undefined`. An absent title is a missing one, so it earns the actionable
  // reason rather than being lumped in with a number or an object.
  if (input === undefined) return { reason: 'title_required' };
  if (typeof input !== 'string') return { reason: 'not_string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { reason: 'title_required' };
  if (codePointLength(trimmed) > TITLE_MAX_CODE_POINTS) {
    return { reason: 'title_too_long', limit: TITLE_MAX_CODE_POINTS };
  }
  return undefined;
};

/** Titles are mandatory. The policy itself lives in `inspectTitleInput`. */
export const TitleInput = Schema.String.pipe(
  Schema.filter((value) => {
    const rejection = inspectTitleInput(value);
    if (rejection === undefined) return true;
    return rejection.reason === 'title_too_long'
      ? `a title may be at most ${TITLE_MAX_CODE_POINTS} characters`
      : 'a title is required';
  }),
);

export const SlugInput = Schema.String.pipe(
  Schema.filter(
    (value) =>
      isCanonicalSlug(value) ||
      `a slug must be a canonical lowercase slug of at most ${SLUG_MAX_CODE_POINTS} characters`,
  ),
);

export const DescriptionInput = Schema.String.pipe(
  Schema.filter(
    (value) =>
      codePointLength(value) <= DESCRIPTION_MAX_CODE_POINTS ||
      `a description may be at most ${DESCRIPTION_MAX_CODE_POINTS} characters`,
  ),
);

/**
 * Tags are trimmed and NFC-normalized on input, then compared for duplicates by exact equality of
 * that normalized form. Case and internal whitespace are preserved and significant, so `Work` and
 * `work` are two different tags. This deliberately avoids a second, case-insensitive identity that
 * storage and filtering would then have to honor; no requirement needs one yet.
 */
const TagInput = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: (value) => value.trim().normalize('NFC'),
  encode: (value) => value,
}).pipe(
  Schema.filter((value) => {
    const length = codePointLength(value);
    if (length < TAG_MIN_CODE_POINTS) return 'a tag must not be empty';
    return length <= TAG_MAX_CODE_POINTS
      ? true
      : `a tag may be at most ${TAG_MAX_CODE_POINTS} characters`;
  }),
);

export const TagsInput = Schema.Array(TagInput).pipe(
  Schema.maxItems(TAGS_MAX_COUNT),
  Schema.filter((tags) => new Set(tags).size === tags.length || 'tags must not repeat'),
);

const METADATA_LIMITS: JsonTraversalLimits = {
  maxDepth: METADATA_MAX_DEPTH,
  maxValues: JSON_SAFETY_MAX_VALUES,
  maxKeyCodePoints: METADATA_MAX_KEY_CODE_POINTS,
};

export type MetadataRejectionReason = 'not_object' | 'too_many_keys' | 'too_large' | 'invalid_json';

export interface MetadataRejection {
  readonly reason: MetadataRejectionReason;
  readonly detail: string;
}

/**
 * Validates submitted metadata without altering it. Structure is checked first, so the serialized
 * size is only measured once the value is known to be bounded. Unknown keys are data, not errors:
 * metadata is the caller's own namespace and is preserved exactly.
 */
export const inspectMetadataInput = (input: unknown): MetadataRejection | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { reason: 'not_object', detail: 'metadata must be a JSON object' };
  }
  const rejection = inspectJsonValue(input, METADATA_LIMITS);
  if (rejection !== undefined) {
    return { reason: 'invalid_json', detail: describeJsonRejection(rejection) };
  }
  const keys = Object.keys(input);
  if (keys.length > METADATA_MAX_TOP_LEVEL_KEYS) {
    return {
      reason: 'too_many_keys',
      detail: `metadata may have at most ${METADATA_MAX_TOP_LEVEL_KEYS} top-level keys`,
    };
  }
  const bytes = utf8ByteLength(JSON.stringify(input));
  if (bytes > METADATA_MAX_SERIALIZED_BYTES) {
    return {
      reason: 'too_large',
      detail: `metadata may be at most ${METADATA_MAX_SERIALIZED_BYTES} bytes when serialized`,
    };
  }
  return undefined;
};

export const MetadataInput = Schema.declare(
  (input: unknown): input is JsonObject => inspectMetadataInput(input) === undefined,
  {
    identifier: 'metadata',
    message: (issue) => {
      const rejection = inspectMetadataInput(issue.actual);
      return rejection === undefined
        ? 'Expected metadata'
        : `Expected metadata: ${rejection.detail}`;
    },
  },
);

/** Metadata as stored and returned: safety-bounded, never re-validated against input limits. */
export const MetadataOutput = JsonObjectSafe;

/**
 * A TipTap document as it travels on the wire. This release validates the transport representation
 * only: a JSON-safe object with a document root and bounded structure. It is deliberately not a
 * partial node allowlist, because the supported-document schema belongs to the content package and a
 * half-specified shape here would have to be undone once that lands.
 */
export type TipTapDocumentTransport = JsonObject & { readonly type: 'doc' };

const documentLimits = (maxValues: number): JsonTraversalLimits => ({
  maxDepth: DOCUMENT_MAX_DEPTH,
  maxValues,
});

const isDocumentTransport = (
  input: unknown,
  limits: JsonTraversalLimits,
): input is TipTapDocumentTransport => {
  if (!isJsonObject(input, limits)) return false;
  if (input['type'] !== 'doc') return false;
  const content = input['content'];
  return content === undefined || Array.isArray(content);
};

const documentSchema = (identifier: string, limits: JsonTraversalLimits) =>
  Schema.declare(
    (input: unknown): input is TipTapDocumentTransport => isDocumentTransport(input, limits),
    {
      identifier,
      message: () =>
        `Expected ${identifier}: a JSON object with "type": "doc" and optional array content, nested at most ${DOCUMENT_MAX_DEPTH} levels`,
    },
  );

export const DocumentTransportInput = documentSchema(
  'a document',
  documentLimits(DOCUMENT_TRANSPORT_MAX_JSON_VALUES),
);

export const DocumentTransportOutput = documentSchema(
  'a document',
  documentLimits(JSON_SAFETY_MAX_VALUES),
);

/**
 * Body input. Markdown is the default, so an omitted `format` means Markdown; `tiptap` must be
 * chosen explicitly. Core owns conversion and canonical storage.
 */
export const BodyInput = Schema.Union(
  Schema.Struct({
    format: Schema.optionalWith(Schema.Literal('markdown'), { exact: true }),
    value: Schema.String,
  }),
  Schema.Struct({
    format: Schema.Literal('tiptap'),
    value: DocumentTransportInput,
  }),
);

/** Body output always states its format, so a client never has to infer which shape it received. */
export const BodyOutput = Schema.Union(
  Schema.Struct({ format: Schema.Literal('markdown'), value: Schema.String }),
  Schema.Struct({ format: Schema.Literal('tiptap'), value: DocumentTransportOutput }),
);

export const IdempotencyKeyInput = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.trim() !== value) {
      return 'an idempotency key must not have leading or trailing whitespace';
    }
    if (value.length === 0) return 'an idempotency key must not be empty';
    if (/\p{Cc}/u.test(value)) return 'an idempotency key must not contain control characters';
    return codePointLength(value) <= IDEMPOTENCY_KEY_MAX_CODE_POINTS
      ? true
      : `an idempotency key may be at most ${IDEMPOTENCY_KEY_MAX_CODE_POINTS} characters`;
  }),
);

export const ListSkipInput = NonNegativeSafeInt;
export const ListLimitInput = PositiveSafeInt.pipe(Schema.between(LIST_LIMIT_MIN, LIST_LIMIT_MAX));
