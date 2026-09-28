/**
 * The hierarchy capability, over HTTP.
 *
 * Each function does three things and no more: decode the request against the shared contract, hand
 * the decoded value to the transport, and decode the answer. No hierarchy rule lives here - not slug
 * derivation, not parentage, not content conversion. Those belong to the server, and a client that
 * reimplemented any of them would be a second authority that could disagree with the first.
 *
 * Decoding the request locally is not that second authority. It is the same schema the server decodes
 * with, applied early so an obviously malformed request fails without a round trip and with a message
 * that names the property. The server still decides; this just declines to waste the trip.
 */

import type { Decoder } from '@raphael/contracts';
import {
  NODE_ROUTES,
  type AddFavoriteResponse,
  type CreateRequestInput,
  type FavoriteListRequestInput,
  type FavoriteRequestInput,
  type GetPathRequestInput,
  type GetRequestInput,
  type LifecycleRequestInput,
  type ListRequestInput,
  type MoveRequestInput,
  type SearchRequestInput,
  type UpdateRequestInput,
  decodeAddFavoriteResponse,
  decodeCreateRequest,
  decodeCreateResponse,
  decodeFavoriteListRequest,
  decodeFavoriteRequest,
  decodeGetPathRequest,
  decodeGetPathResponse,
  decodeGetRequest,
  decodeGetResponse,
  decodeLifecycleRequest,
  decodeLifecycleResponse,
  decodeListRequest,
  decodeListResponse,
  decodeMoveRequest,
  decodeMoveResponse,
  decodeRemoveFavoriteResponse,
  decodeSearchRequest,
  decodeSearchResponse,
  decodeUpdateRequest,
  decodeUpdateResponse,
  type CreateResponse,
  type GetPathResponse,
  type GetResponse,
  type LifecycleResponse,
  type ListResponse,
  type MoveResponse,
  type RemoveFavoriteResponse,
  type SearchResponse,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { fail, type ClientResult } from '../shared/failure.ts';
import type { Transport } from '../shared/transport.ts';

const run = async <A>(
  transport: Transport,
  route: { readonly method: 'POST'; readonly path: string },
  decodeRequest: Decoder<unknown>,
  decodeResponse: Decoder<A>,
  request: unknown,
  successStatus: number,
  signal?: AbortSignal,
): Promise<ClientResult<A>> => {
  const decoded = decodeRequest(request);
  if (Either.isLeft(decoded)) {
    return fail({ kind: 'invalid_request', message: decoded.left.message });
  }
  // The decoded value is what travels, not the caller's object. Effect Schema returns a new
  // structure, so a caller mutating its input after this point cannot change the logical attempt.
  return transport.invoke({
    route,
    body: decoded.right,
    decode: decodeResponse,
    successStatus,
    ...(signal === undefined ? {} : { signal }),
  });
};

/** Create one node - a container or a resource. Answers 201. */
export const create = (
  transport: Transport,
  request: CreateRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<CreateResponse>> =>
  run(
    transport,
    NODE_ROUTES.create,
    decodeCreateRequest as Decoder<unknown>,
    decodeCreateResponse,
    request,
    201,
    signal,
  );

/**
 * Change one existing area, project, or note. Answers 200. The revision it names is the safety: a
 * stale one is refused as `revision_conflict`.
 */
export const update = (
  transport: Transport,
  request: UpdateRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<UpdateResponse>> =>
  run(
    transport,
    NODE_ROUTES.update,
    decodeUpdateRequest as Decoder<unknown>,
    decodeUpdateResponse,
    request,
    200,
    signal,
  );

/**
 * Move one existing area, project, or note, optionally under a new address. Answers 200. Whether a
 * path names a container or a new address is the server's decision.
 */
export const move = (
  transport: Transport,
  request: MoveRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<MoveResponse>> =>
  run(
    transport,
    NODE_ROUTES.move,
    decodeMoveRequest as Decoder<unknown>,
    decodeMoveResponse,
    request,
    200,
    signal,
  );

/**
 * Archive one existing area, project, or note: add the user's own cause to it. Answers 200.
 * Archiving something the user already archived succeeds without a change.
 */
export const archive = (
  transport: Transport,
  request: LifecycleRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<LifecycleResponse>> =>
  run(
    transport,
    NODE_ROUTES.archive,
    decodeLifecycleRequest as Decoder<unknown>,
    decodeLifecycleResponse,
    request,
    200,
    signal,
  );

/**
 * Restore one area, project, or note: remove the user's own cause from it. Answers 200.
 *
 * The same safety as `archive`. A restore can leave the node archived - through a container above it,
 * or by another cause - and the response says so; a caller must not report "restored" from the verb.
 */
export const restore = (
  transport: Transport,
  request: LifecycleRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<LifecycleResponse>> =>
  run(
    transport,
    NODE_ROUTES.restore,
    decodeLifecycleRequest as Decoder<unknown>,
    decodeLifecycleResponse,
    request,
    200,
    signal,
  );

export const get = (
  transport: Transport,
  request: GetRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<GetResponse>> =>
  run(
    transport,
    NODE_ROUTES.get,
    decodeGetRequest as Decoder<unknown>,
    decodeGetResponse,
    request,
    200,
    signal,
  );

export const list = (
  transport: Transport,
  request: ListRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<ListResponse>> =>
  run(
    transport,
    NODE_ROUTES.list,
    decodeListRequest as Decoder<unknown>,
    decodeListResponse,
    request,
    200,
    signal,
  );

/**
 * Find areas, projects and notes by their text, within the given scopes. Answers 200.
 *
 * The same three steps as `list`, and the same division of authority: the query grammar is the
 * contract's, its translation into an engine match string is the server's, and nothing here rewrites
 * a caller's query on the way past.
 */
export const search = (
  transport: Transport,
  request: SearchRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<SearchResponse>> =>
  run(
    transport,
    NODE_ROUTES.search,
    decodeSearchRequest as Decoder<unknown>,
    decodeSearchResponse,
    request,
    200,
    signal,
  );

/**
 * Make an area or a project a favorite. Answers 200 with `{ nodeId, isFavorite: true }`. The request
 * states the desired result, so sending it again is harmless. A note is refused by the server.
 */
export const addFavorite = (
  transport: Transport,
  request: FavoriteRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<AddFavoriteResponse>> =>
  run(
    transport,
    NODE_ROUTES.addFavorite,
    decodeFavoriteRequest as Decoder<unknown>,
    decodeAddFavoriteResponse,
    request,
    200,
    signal,
  );

/** Make a node not a favorite. The same safety as `addFavorite`; answers `{ nodeId, isFavorite: false }`. */
export const removeFavorite = (
  transport: Transport,
  request: FavoriteRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<RemoveFavoriteResponse>> =>
  run(
    transport,
    NODE_ROUTES.removeFavorite,
    decodeFavoriteRequest as Decoder<unknown>,
    decodeRemoveFavoriteResponse,
    request,
    200,
    signal,
  );

/** One page of favorites that are not archived, by title then id. Answers 200 with an ordinary page. */
export const listFavorites = (
  transport: Transport,
  request: FavoriteListRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<ListResponse>> =>
  run(
    transport,
    NODE_ROUTES.listFavorites,
    decodeFavoriteListRequest as Decoder<unknown>,
    decodeListResponse,
    request,
    200,
    signal,
  );

export const getPath = (
  transport: Transport,
  request: GetPathRequestInput,
  signal?: AbortSignal,
): Promise<ClientResult<GetPathResponse>> =>
  run(
    transport,
    NODE_ROUTES.getPath,
    decodeGetPathRequest as Decoder<unknown>,
    decodeGetPathResponse,
    request,
    200,
    signal,
  );
