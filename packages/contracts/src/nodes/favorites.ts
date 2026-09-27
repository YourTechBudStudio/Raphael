import { Schema } from 'effect';

import { requestDecoder, responseDecoder } from '../shared/decode.ts';
import { NodeId } from './fields.ts';
import { EntitySelector, PageWindowFields } from './operations.ts';

/**
 * Favorites: a separate collection of node identities, not a field on the node.
 *
 * Add and remove state the desired result, so repeating either is harmless. Neither takes a revision,
 * because a favorite is not part of what a revision guards. Each answers only the node's id and the
 * resulting state, never a full node, so an answer cannot overwrite content a client is editing.
 */

/** One node, by id or by path. The root is not a node and cannot be a favorite. */
export const FavoriteRequest = Schema.Struct({ target: EntitySelector });

/** The literal makes a contradictory answer (`add` answering `false`) fail at the boundary. */
export const AddFavoriteResponse = Schema.Struct({
  nodeId: NodeId,
  isFavorite: Schema.Literal(true),
});
export const RemoveFavoriteResponse = Schema.Struct({
  nodeId: NodeId,
  isFavorite: Schema.Literal(false),
});

/**
 * One page of favorites that are not archived, ordered by title compared without regard to ASCII case,
 * then by id. Accented and other non-ASCII letters compare by code point, and titles are not
 * Unicode-normalized. The answer is the ordinary `ListResponse`: complete node summaries, each with
 * `isFavorite: true`.
 */
export const FavoriteListRequest = Schema.Struct({ ...PageWindowFields });

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
