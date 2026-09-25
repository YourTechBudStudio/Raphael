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
  type CreateRequestInput,
  type GetPathRequestInput,
  type GetRequestInput,
  type LifecycleRequestInput,
  type ListRequestInput,
  type MoveRequestInput,
  type SearchRequestInput,
  type UpdateRequestInput,
  decodeCreateRequest,
  decodeCreateResponse,
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
  type SearchResponse,
  type UpdateResponse,
} from '@raphael/contracts/nodes';
import { Either } from 'effect';

import { fail, type ClientResult, type MutationOutcome } from '../shared/failure.ts';
import type { Transport } from '../shared/transport.ts';

/**
 * Creation, with everything the wire contract accepts, and one field made mandatory.
 *
 * The wire contract leaves it optional, because an arbitrary API caller may reasonably choose not to
 * use one. A first-party client may not: the key is the only way an uncertain creation can be
 * resolved, and "the client forgot to generate one" is a state in which recovery is impossible. It is
 * the caller's to generate rather than this package's, because `crypto.randomUUID` does not exist on
 * every runtime this code runs on, and a transport that silently produced a weaker identifier on one
 * platform would be worse than one that asks.
 *
 * The conditional is what makes the rewrite *distributive*. `CreateRequestInput` is a union of a
 * container request and a resource request, and a bare `Omit` over a union collapses it to the
 * properties its members share - which would silently erase `kind`, discard the discriminant, and make
 * a container's mandatory title optional. Distributing rewrites each member separately, so a container
 * still requires a title, a note still requires a kind and may omit its title, and a container still
 * cannot carry one.
 */
type WithRequiredKey<T> = T extends unknown
  ? Omit<T, 'idempotencyKey'> & { readonly idempotencyKey: string }
  : never;

export type CreateInput = WithRequiredKey<CreateRequestInput>;

const run = async <A>(
  transport: Transport,
  route: { readonly method: 'POST'; readonly path: string },
  decodeRequest: Decoder<unknown>,
  decodeResponse: Decoder<A>,
  request: unknown,
  successStatus: number,
  mutating: boolean,
  signal?: AbortSignal,
): Promise<ClientResult<A>> => {
  const decoded = decodeRequest(request);
  if (Either.isLeft(decoded)) {
    const issue = decoded.left.issues[0];
    return fail({
      kind: 'invalid_request',
      mutationOutcome: 'not_dispatched' satisfies MutationOutcome,
      message: decoded.left.message,
      path: issue?.path ?? [],
    });
  }
  // The decoded value is what travels, not the caller's object. Effect Schema returns a new
  // structure, so a caller mutating its input after this point cannot change the logical attempt.
  return transport.invoke({
    route,
    body: decoded.right,
    decode: decodeResponse,
    successStatus,
    mutating,
    ...(signal === undefined ? {} : { signal }),
  });
};

/**
 * Create one node - a container or a resource. Answers 201, including when the answer is a replay of an
 * earlier attempt with the same key: a replay is a success reporting the entity that exists, not a
 * different outcome.
 */
export const create = (
  transport: Transport,
  request: CreateInput,
  signal?: AbortSignal,
): Promise<ClientResult<CreateResponse>> =>
  run(
    transport,
    NODE_ROUTES.create,
    decodeCreateRequest as Decoder<unknown>,
    decodeCreateResponse,
    request,
    201,
    true,
    signal,
  );

/**
 * Change one existing area, project, or note. Answers 200.
 *
 * No idempotency key and no replay, deliberately: an update's safety is the revision it names, not a
 * key. A caller sends the revision it read, and the server's compare-and-set either applies the change
 * to that exact version or refuses it as `revision_conflict`. There is nothing to replay, because a
 * repeat of an applied update would be a second write against a revision that has already moved.
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
    true,
    signal,
  );

/**
 * Move one existing area, project, or note, optionally under a new address. Answers 200.
 *
 * `mutating`, and without an idempotency key for the reason `update` gives: the revision is the safety,
 * and a lost answer is reported as `mutationOutcome: 'unknown'` for the caller to reconcile by
 * re-reading. The destination travels exactly as decoded; whether a path names a container or a new
 * address is the server's decision, made against its current state.
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
    true,
    signal,
  );

/**
 * Archive one existing area, project, or note: add the user's own cause to it. Answers 200.
 *
 * `mutating`, and without an idempotency key for the reason `update` gives: the revision is the safety,
 * and a lost answer is reported as `mutationOutcome: 'unknown'` for the caller to reconcile by
 * re-reading. Archiving something the user already archived succeeds without a change. The response
 * states the resulting status and the causes that apply, which is what a caller words its result by.
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
    true,
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
    true,
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
    false,
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
    false,
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
    false,
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
    false,
    signal,
  );
