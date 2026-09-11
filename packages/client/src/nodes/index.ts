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
  type ListRequestInput,
  decodeCreateRequest,
  decodeCreateResponse,
  decodeGetPathRequest,
  decodeGetPathResponse,
  decodeGetRequest,
  decodeGetResponse,
  decodeListRequest,
  decodeListResponse,
  type CreateResponse,
  type GetPathResponse,
  type GetResponse,
  type ListResponse,
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
 */
export type CreateInput = Omit<CreateRequestInput, 'idempotencyKey'> & {
  readonly idempotencyKey: string;
};

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
 * Create one container. Answers 201, including when the answer is a replay of an earlier attempt with
 * the same key - a replay is a success reporting the entity that exists, not a different outcome.
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
