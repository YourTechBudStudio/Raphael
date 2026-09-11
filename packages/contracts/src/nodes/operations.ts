import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { NonNegativeSafeInt, PositiveSafeInt } from '../shared/numbers.ts';
import type { RouteDescriptor } from '../shared/route.ts';
import {
  BodyFormatSchema,
  BodyInput,
  BodyOutput,
  DescriptionInput,
  IdempotencyKeyInput,
  LIST_LIMIT_DEFAULT,
  LIST_SKIP_DEFAULT,
  ListLimitInput,
  ListSkipInput,
  MetadataInput,
  MetadataOutput,
  NODE_TYPES,
  NodeId,
  NodeRevision,
  NodeTypeSchema,
  SlugInput,
  TagsInput,
  TitleInput,
} from './fields.ts';
import { ROOT_PATH, isCanonicalPath, isEntityPath } from './path.ts';
import { isCanonicalSlugShape } from './slug.ts';

/** A path usable as a scope, including the virtual root. */
export const ScopePath = Schema.String.pipe(
  Schema.filter((value) => isCanonicalPath(value) || 'a path must be a canonical absolute path'),
);

/**
 * A path that addresses an entity. The root is a valid scope but cannot select one, and that is a
 * malformed selector rather than a missing node, so it is refused as invalid input.
 */
export const EntityPath = Schema.String.pipe(
  Schema.filter((value) => {
    if (value === ROOT_PATH) return 'the root path cannot select an entity';
    return isEntityPath(value) || 'a path must be a canonical absolute path';
  }),
);

/**
 * A selector carries exactly one of `id` or `path`. Strict request decoding is what rejects a
 * selector carrying both; selectors only ever appear in requests.
 */
export const ScopeSelector = Schema.Union(
  Schema.Struct({ id: NodeId }),
  Schema.Struct({ path: ScopePath }),
);

export const EntitySelector = Schema.Union(
  Schema.Struct({ id: NodeId }),
  Schema.Struct({ path: EntityPath }),
);

export type ScopeSelector = Schema.Schema.Type<typeof ScopeSelector>;
export type EntitySelector = Schema.Schema.Type<typeof EntitySelector>;

/**
 * A list filter. Omitted means every type this release supports; an empty array is invalid, so a
 * caller cannot accidentally ask for nothing and read the empty page as an empty hierarchy.
 */
export const NodeTypeFilter = Schema.Array(NodeTypeSchema).pipe(
  Schema.minItems(1),
  Schema.maxItems(NODE_TYPES.length),
  Schema.filter((types) => new Set(types).size === types.length || 'types must not repeat'),
);

export const CreateRequest = Schema.Struct({
  type: NodeTypeSchema,
  parent: ScopeSelector,
  title: TitleInput,
  slug: Schema.optional(SlugInput),
  description: Schema.optional(DescriptionInput),
  body: Schema.optional(BodyInput),
  tags: Schema.optional(TagsInput),
  metadata: Schema.optional(MetadataInput),
  idempotencyKey: Schema.optional(IdempotencyKeyInput),
  /** The format the returned body is rendered in. `body.format` describes the submitted body. */
  format: Schema.optionalWith(BodyFormatSchema, {
    default: () => 'markdown' as const,
    exact: true,
  }),
});

export const GetRequest = Schema.Struct({
  target: EntitySelector,
  format: Schema.optionalWith(BodyFormatSchema, {
    default: () => 'markdown' as const,
    exact: true,
  }),
});

export const ListRequest = Schema.Struct({
  parent: ScopeSelector,
  recursive: Schema.optionalWith(Schema.Boolean, { default: () => false, exact: true }),
  types: Schema.optional(NodeTypeFilter),
  skip: Schema.optionalWith(ListSkipInput, { default: () => LIST_SKIP_DEFAULT, exact: true }),
  limit: Schema.optionalWith(ListLimitInput, { default: () => LIST_LIMIT_DEFAULT, exact: true }),
});

export const GetPathRequest = Schema.Struct({ target: EntitySelector });

export type CreateRequest = Schema.Schema.Type<typeof CreateRequest>;
export type GetRequest = Schema.Schema.Type<typeof GetRequest>;
export type ListRequest = Schema.Schema.Type<typeof ListRequest>;
export type GetPathRequest = Schema.Schema.Type<typeof GetPathRequest>;

/**
 * Response projections. Every field is always present: `parentId` is a positive ID or `null` for a
 * root child, `description` is the empty string when unset, `tags` is always an array. A decoder never
 * fills a missing field in, because that would hide a malformed response behind a plausible default.
 *
 * Authored values are validated for structure and identity invariants, not against input limits, so a
 * stored value stays readable by a client whose own creation limits have since changed. A slug is still
 * checked for canonical shape, because an address that would be refused as a selector cannot honestly
 * describe the entity that was just returned; only its submission length bound is left out.
 */
export const NodeSummary = Schema.Struct({
  id: NodeId,
  type: NodeTypeSchema,
  parentId: Schema.NullOr(NodeId),
  slug: Schema.String.pipe(
    Schema.filter((value) => isCanonicalSlugShape(value) || 'a slug must be a canonical slug'),
  ),
  revision: NodeRevision,
  title: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
});

export const NodeEntity = Schema.Struct({
  ...NodeSummary.fields,
  body: BodyOutput,
  metadata: MetadataOutput,
});

export type NodeSummary = Schema.Schema.Type<typeof NodeSummary>;
export type NodeEntity = Schema.Schema.Type<typeof NodeEntity>;

export const CreateResponse = Schema.Struct({ entity: NodeEntity });
export const GetResponse = Schema.Struct({ entity: NodeEntity });

export const ListResponse = Schema.Struct({
  items: Schema.Array(NodeSummary),
  skip: NonNegativeSafeInt,
  limit: PositiveSafeInt,
  hasMore: Schema.Boolean,
});

/**
 * A computed path must be one that can be handed straight back as a selector. The root is therefore
 * refused here as well: it addresses no entity, so it cannot be the path of the entity asked about.
 */
export const GetPathResponse = Schema.Struct({
  id: NodeId,
  path: Schema.String.pipe(
    Schema.filter((value) => isEntityPath(value) || 'a path must be a canonical entity path'),
  ),
});

export type CreateResponse = Schema.Schema.Type<typeof CreateResponse>;
export type GetResponse = Schema.Schema.Type<typeof GetResponse>;
export type ListResponse = Schema.Schema.Type<typeof ListResponse>;
export type GetPathResponse = Schema.Schema.Type<typeof GetPathResponse>;

/**
 * What a caller passes in, as opposed to what a decoder hands back.
 *
 * These are the schemas' *encoded* side, and they differ from the decoded types in ways that matter to
 * anyone assembling a request: `format`, `skip`, and `limit` are optional here and always present
 * there, and a field with a transform accepts its submitted shape rather than its stored one. Typing a
 * client operation with the decoded type would demand that callers supply values the decoder exists to
 * supply for them.
 *
 * Runtime decoding is still the authority. These types make an ordinary mistake a compile error; they
 * do not make the decode step optional, because a caller in plain JavaScript has no types at all.
 */
export type CreateRequestInput = Schema.Schema.Encoded<typeof CreateRequest>;
export type GetRequestInput = Schema.Schema.Encoded<typeof GetRequest>;
export type ListRequestInput = Schema.Schema.Encoded<typeof ListRequest>;
export type GetPathRequestInput = Schema.Schema.Encoded<typeof GetPathRequest>;

export const decodeCreateRequest = requestDecoder(CreateRequest);
export const decodeGetRequest = requestDecoder(GetRequest);
export const decodeListRequest = requestDecoder(ListRequest);
export const decodeGetPathRequest = requestDecoder(GetPathRequest);

export const decodeCreateResponse = responseDecoder(CreateResponse);
export const decodeGetResponse = responseDecoder(GetResponse);
export const decodeListResponse = responseDecoder(ListResponse);
export const decodeGetPathResponse = responseDecoder(GetPathResponse);

export const NODE_ROUTES = {
  create: { method: 'POST', path: '/api/nodes/create' },
  get: { method: 'POST', path: '/api/nodes/get' },
  list: { method: 'POST', path: '/api/nodes/list' },
  getPath: { method: 'POST', path: '/api/nodes/get-path' },
} as const satisfies Record<string, RouteDescriptor>;
