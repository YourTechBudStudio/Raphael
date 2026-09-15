import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { NonNegativeSafeInt, PositiveSafeInt } from '../shared/numbers.ts';
import type { RouteDescriptor } from '../shared/route.ts';
import {
  BodyFormatSchema,
  BodyInput,
  BodyOutput,
  ContainerTypeSchema,
  DescriptionInput,
  IdempotencyKeyInput,
  LIST_LIMIT_DEFAULT,
  LIST_SKIP_DEFAULT,
  ListLimitInput,
  ListSkipInput,
  MetadataInput,
  MetadataOutput,
  NODE_ORDER_FIELDS,
  NODE_TYPES,
  NodeId,
  NodeOrderFieldSchema,
  NodeRevision,
  NodeTypeSchema,
  OrderDirectionSchema,
  ResourceKindSchema,
  type NodeType,
  type ResourceKind,
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

/** Everything both members of the creation union accept, spelled once. */
const CreateCommon = {
  parent: ScopeSelector,
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
};

/** A container. It must be named, and it has no kind: a kind says what a leaf is. */
export const ContainerCreateRequest = Schema.Struct({
  type: ContainerTypeSchema,
  title: TitleInput,
  ...CreateCommon,
});

/**
 * A resource. Its kind is required, and its title is not.
 *
 * An omitted title is resolved by core from the submitted content, which is why it is optional here
 * rather than defaulted: there is nothing a contract could put in its place that would not be an
 * invented name. A supplied title is still validated as authored input.
 */
export const ResourceCreateRequest = Schema.Struct({
  type: Schema.Literal('resource'),
  kind: ResourceKindSchema,
  title: Schema.optional(TitleInput),
  ...CreateCommon,
});

/**
 * Creation, as a discriminated union rather than one struct with an optional kind.
 *
 * The shape is what enforces the rules, so no downstream code has to. Strict request decoding
 * refuses excess properties, so `kind` on an area is rejected by the container member and by the type
 * literal in the resource member - a container cannot carry a kind. A resource without a kind, or with
 * an unsupported one, is refused before any storage rule runs, so bare `resource` creation is
 * impossible at the contract. And a container without a title still fails on `TitleInput`, so existing
 * `title_required` recovery wording for containers is unchanged.
 */
export const CreateRequest = Schema.Union(ContainerCreateRequest, ResourceCreateRequest);

export const GetRequest = Schema.Struct({
  target: EntitySelector,
  format: Schema.optionalWith(BodyFormatSchema, {
    default: () => 'markdown' as const,
    exact: true,
  }),
});

/**
 * One ordering clause. Array order is priority order.
 *
 * Omitting `orderBy` means slug ascending then id ascending, which is what listing has always done.
 * An explicit array replaces that default rather than extending it, and core appends an id clause only
 * when none was given - so every ordering is total, and a caller that wants id descending gets it in
 * the position they asked for rather than having a second id clause bolted on behind it.
 */
export const NodeOrderClause = Schema.Struct({
  field: NodeOrderFieldSchema,
  direction: OrderDirectionSchema,
});

export const NodeOrderBy = Schema.Array(NodeOrderClause).pipe(
  Schema.minItems(1),
  Schema.maxItems(NODE_ORDER_FIELDS.length),
  Schema.filter(
    (clauses) =>
      new Set(clauses.map((clause) => clause.field)).size === clauses.length ||
      'order fields must not repeat',
  ),
);

export type NodeOrderClause = Schema.Schema.Type<typeof NodeOrderClause>;
export type NodeOrderBy = Schema.Schema.Type<typeof NodeOrderBy>;

export const ListRequest = Schema.Struct({
  parent: ScopeSelector,
  recursive: Schema.optionalWith(Schema.Boolean, { default: () => false, exact: true }),
  types: Schema.optional(NodeTypeFilter),
  orderBy: Schema.optional(NodeOrderBy),
  skip: Schema.optionalWith(ListSkipInput, { default: () => LIST_SKIP_DEFAULT, exact: true }),
  limit: Schema.optionalWith(ListLimitInput, { default: () => LIST_LIMIT_DEFAULT, exact: true }),
});

export const GetPathRequest = Schema.Struct({ target: EntitySelector });

export type ContainerCreateRequest = Schema.Schema.Type<typeof ContainerCreateRequest>;
export type ResourceCreateRequest = Schema.Schema.Type<typeof ResourceCreateRequest>;
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
const NodeSummaryFields = {
  id: NodeId,
  type: NodeTypeSchema,
  /**
   * The resource kind, or `null` for a container. Always present, never inferred from the type.
   *
   * A closed literal union for the same reason `type` is: an unsupported discriminant is a response
   * this client cannot represent, and saying so is better than carrying an unknown string into
   * presentation.
   */
  kind: Schema.NullOr(ResourceKindSchema),
  parentId: Schema.NullOr(NodeId),
  slug: Schema.String.pipe(
    Schema.filter((value) => isCanonicalSlugShape(value) || 'a slug must be a canonical slug'),
  ),
  revision: NodeRevision,
  title: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
};

/**
 * A resource carries a kind and a container does not.
 *
 * Checking the two fields independently would let the decoder accept combinations the contract says
 * cannot exist — `{ type: 'area', kind: 'note' }`, or a resource whose kind is `null`. That matters
 * precisely because decoding is the integration boundary: a caller treats a response that decoded as
 * one it can trust, so a malformed or incompatible server would be believed rather than caught. The
 * CLI would print `area.note`, and a consumer that recognizes containers by `type` alone would take a
 * kinded area for an ordinary one.
 *
 * It is the same argument that makes `kind` a closed literal rather than a string, applied one step
 * further: a discriminant pairing this client cannot represent is better refused than carried into
 * presentation. Our own server already enforces this on the way out, so this guards the case that
 * guarantee does not cover — a different, older, or faulty server on the other end.
 */
const kindMatchesType = (value: {
  readonly type: NodeType;
  readonly kind: ResourceKind | null;
}): true | string =>
  (value.type === 'resource') === (value.kind !== null) ||
  'a resource must carry a kind and a container must not';

export const NodeSummary = Schema.Struct(NodeSummaryFields).pipe(Schema.filter(kindMatchesType));

export const NodeEntity = Schema.Struct({
  ...NodeSummaryFields,
  body: BodyOutput,
  metadata: MetadataOutput,
}).pipe(Schema.filter(kindMatchesType));

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
