import { Either, Schema } from 'effect';

import {
  NODE_TYPES,
  NodeTypeSchema,
  RESOURCE_KINDS,
  ResourceKindSchema,
  TAGS_MAX_COUNT,
  TagInput,
} from './fields.ts';

/**
 * The structured predicate both List and Search take.
 *
 * A **closed** Mongo-shaped subset, not a query language. Three keys, each either a scalar or
 * `{ $in: [...] }`, siblings ANDed. That shape was chosen so the operators a later story needs -
 * `$nin`, `$all`, `$and`/`$or`, metadata paths - can be added without a second spelling of what
 * exists today; it is not an invitation to forward arbitrary Mongo syntax to storage. Every value is
 * bound as a parameter by the backend, and nothing here ever becomes SQL text.
 *
 * Semantics:
 *
 * - An omitted `filter`, or an omitted key, restricts nothing on that dimension.
 * - A scalar is `$in` of one. The two spellings mean exactly the same thing.
 * - Keys are ANDed: `{ type: 'resource', tags: 'auth' }` is a note that also carries the tag.
 * - `tags` means the node carries **at least one** of the listed tags.
 * - `kind` does not imply `type: 'resource'`. A container's kind is null and simply does not match,
 *   which is the same answer by a shorter route.
 *
 * Tag identity is the one the contract already fixed and does not get a second definition here:
 * `TagInput` trims and NFC-normalizes, and comparison is exact and case-sensitive, so `Work` and
 * `work` are two tags. That is why a filter value goes through `TagInput` rather than being compared
 * as a raw string - a submitted `" backend "` must find a stored `backend`.
 *
 * Unknown keys are refused by the schema itself, because requests are decoded with excess properties
 * as an error. That is a property of the shape rather than a rule someone must remember to apply.
 */

const noRepeats = <A>(values: readonly A[]): true | string =>
  new Set(values).size === values.length || 'values must not repeat';

/**
 * The one operator this release supports. `minItems(1)` is what stops a caller asking for nothing and
 * reading the empty page as an empty hierarchy - the same reason the old type filter refused an empty
 * array.
 */
const inOf = <A, I>(item: Schema.Schema<A, I>, max: number) =>
  Schema.Struct({
    $in: Schema.Array(item).pipe(
      Schema.minItems(1),
      Schema.maxItems(max),
      Schema.filter(noRepeats),
    ),
  });

/**
 * Each key's value schema, named once.
 *
 * `NodeFilter` is assembled from these, and `inspectFilterInput` decodes against the very same
 * schemas rather than re-deriving the rules or reading the struct decoder's issue paths. That is what
 * makes the helper's verdict and the decoder's verdict the same verdict by construction, which is the
 * property its tests assert case by case.
 */
const FILTER_MEMBERS = {
  type: Schema.Union(NodeTypeSchema, inOf(NodeTypeSchema, NODE_TYPES.length)),
  kind: Schema.Union(ResourceKindSchema, inOf(ResourceKindSchema, RESOURCE_KINDS.length)),
  tags: Schema.Union(TagInput, inOf(TagInput, TAGS_MAX_COUNT)),
} as const;

/**
 * One decoder per key, built from the very schemas the struct is assembled from.
 *
 * Built eagerly and named individually rather than indexed generically, so each decoder keeps its own
 * key's literal types; the record's annotation is what widens them for a loop that does not care which
 * key it is holding.
 */
const FILTER_DECODERS: Readonly<
  Record<'type' | 'kind' | 'tags', (value: unknown) => Either.Either<unknown, unknown>>
> = {
  type: Schema.decodeUnknownEither(FILTER_MEMBERS.type),
  kind: Schema.decodeUnknownEither(FILTER_MEMBERS.kind),
  tags: Schema.decodeUnknownEither(FILTER_MEMBERS.tags),
};

/** The keys this filter owns. A name outside this list is not a predicate we can honor. */
export const FILTER_KEYS = ['type', 'kind', 'tags'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const NodeFilter = Schema.Struct({
  type: Schema.optional(FILTER_MEMBERS.type),
  kind: Schema.optional(FILTER_MEMBERS.kind),
  tags: Schema.optional(FILTER_MEMBERS.tags),
});

export type NodeFilter = Schema.Schema.Type<typeof NodeFilter>;
export type NodeFilterInput = Schema.Schema.Encoded<typeof NodeFilter>;

export type FilterRejectionReason =
  /** Not an object at all. */
  | 'not_object'
  /** A key outside the three this filter owns. */
  | 'unsupported_key'
  /** An operator object using something other than `$in`. */
  | 'unsupported_operator'
  /** A supported key and operator carrying a value the contract refuses. */
  | 'invalid_value';

export interface FilterRejection {
  readonly reason: FilterRejectionReason;
  /** One of the three known keys, when the problem is inside one. Never a submitted name. */
  readonly key?: FilterKey;
}

const isPlainObject = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Whether a value is written as an operator, and whether it is the one operator we have.
 *
 * An object where a scalar or `{ $in }` belongs is an operator the caller expected us to understand,
 * so `$nin`, `{}` and `{ $in: [...], extra: 1 }` are all reported as unsupported operators rather than
 * as bad values.
 *
 * An **array** is deliberately not an operator object. `{ type: ["area"] }` is a plausible mistake -
 * the bare-array shorthand other filter languages allow - and calling it an unsupported *operator*
 * would name the wrong thing. It is a value this contract refuses, and it is reported as one.
 */
const isUnsupportedOperator = (value: unknown): boolean =>
  isPlainObject(value) && !(Object.keys(value).length === 1 && Object.hasOwn(value, '$in'));

/**
 * Names what is wrong with a submitted filter, without repeating anything submitted.
 *
 * The decoder stays the authority; this exists so a CLI can say which rule was broken before sending,
 * and so the server can pick a public reason without reading a decoder message. It returns only our
 * own vocabulary: a reason, and at most one of the three key names this contract owns.
 */
export const inspectFilterInput = (input: unknown): FilterRejection | undefined => {
  if (!isPlainObject(input)) return { reason: 'not_object' };

  for (const key of Object.keys(input)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) return { reason: 'unsupported_key' };
  }

  for (const key of FILTER_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (isUnsupportedOperator(value)) return { reason: 'unsupported_operator', key };
    if (Either.isLeft(FILTER_DECODERS[key](value))) return { reason: 'invalid_value', key };
  }

  return undefined;
};

/** One fixed sentence per reason. A key name is ours; nothing submitted is ever interpolated. */
export const describeFilterRejection = (rejection: FilterRejection): string => {
  switch (rejection.reason) {
    case 'not_object':
      return 'a filter must be a JSON object';
    case 'unsupported_key':
      return `a filter may only use ${FILTER_KEYS.join(', ')}`;
    case 'unsupported_operator':
      // Phrased so the key can be plural: `tags` is one of the three, and "tags supports" is not a
      // sentence anyone should be shown beside a field.
      return `only the $in operator is supported for ${rejection.key ?? 'this filter key'}`;
    case 'invalid_value':
      return `the value given for ${rejection.key ?? 'this filter key'} is not one this filter accepts`;
  }
};
