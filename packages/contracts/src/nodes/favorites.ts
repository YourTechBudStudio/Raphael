import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { NodeId } from './fields.ts';
import { EntitySelector, IncludePathsField, NodeSummary, PageWindowFields } from './operations.ts';

/**
 * Favorites: a separate collection of node identities, not a field on the node.
 *
 * Add and remove state the desired result, so repeating either is harmless; `changed` says whether
 * this call made the difference. Neither takes a revision, because a favorite is not part of what a
 * revision guards. Each answers the node's id, the resulting state, and the node's summary so a caller
 * can name what it marked - never a body, so an answer cannot overwrite content a client is editing.
 */

/** One node, by id or by path. The root is not a node and cannot be a favorite. */
export const FavoriteRequest = Schema.Struct({
  target: EntitySelector,
  includePaths: IncludePathsField,
});

/** The literal makes a contradictory answer (`add` answering `false`) fail at the boundary. */
export const AddFavoriteResponse = Schema.Struct({
  nodeId: NodeId,
  isFavorite: Schema.Literal(true),
  changed: Schema.Boolean,
  node: NodeSummary,
});

/**
 * Removing an id that names nothing still succeeds, because absence is the result asked for. `node` is
 * `null` exactly then, and `changed` is false.
 */
export const RemoveFavoriteResponse = Schema.Struct({
  nodeId: NodeId,
  isFavorite: Schema.Literal(false),
  changed: Schema.Boolean,
  node: Schema.NullOr(NodeSummary),
});

/**
 * One page of favorites, ordered by title compared without regard to ASCII case, then by id. Accented
 * and other non-ASCII letters compare by code point, and titles are not Unicode-normalized. Archived
 * favorites are left out unless `includeArchived` is set, as in a listing. The answer is the ordinary
 * `ListResponse`: complete node summaries, each with `isFavorite: true`, and `archivedLeftOut`.
 */
export const FavoriteListRequest = Schema.Struct({
  ...PageWindowFields,
  includeArchived: Schema.optionalWith(Schema.Boolean, { default: () => false, exact: true }),
  includePaths: IncludePathsField,
});

export type FavoriteRequest = Schema.Schema.Type<typeof FavoriteRequest>;
export type AddFavoriteResponse = Schema.Schema.Type<typeof AddFavoriteResponse>;
export type RemoveFavoriteResponse = Schema.Schema.Type<typeof RemoveFavoriteResponse>;
export type FavoriteListRequest = Schema.Schema.Type<typeof FavoriteListRequest>;
export type FavoriteRequestInput = Schema.Schema.Encoded<typeof FavoriteRequest>;
export type FavoriteListRequestInput = Schema.Schema.Encoded<typeof FavoriteListRequest>;

export const decodeFavoriteRequest = requestDecoder(FavoriteRequest);
export const decodeFavoriteListRequest = requestDecoder(FavoriteListRequest);
export const decodeAddFavoriteResponse = responseDecoder(AddFavoriteResponse);
export const decodeRemoveFavoriteResponse = responseDecoder(RemoveFavoriteResponse);
