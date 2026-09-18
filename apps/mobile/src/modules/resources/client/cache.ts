/**
 * What a write does to what is cached.
 *
 * Two operations, both activation-scoped, all free of React and of the connection store so they can
 * be driven directly. The scoping is the point: the predicate these replaced matched a key segment
 * alone, so a write against one server marked a retired server's caches stale - through a transport
 * that is gone, into keys nothing reads.
 */

import type { QueryClient } from '@tanstack/react-query';

import { activationOf } from '../../../infrastructure/query/keys.ts';
import { NOTES_SEGMENT } from './requests.ts';

/** The cache segment session-only media lives under. Server notes have their own. */
export const MEDIA_SEGMENT = 'session-media';

const inScope = (client: QueryClient, activation: number, segment: string): Promise<void> =>
  client.invalidateQueries({
    predicate: (query) =>
      activationOf(query.queryKey) === activation && query.queryKey[2] === segment,
  });

/**
 * Every view of the server's notes is out of date.
 *
 * Both traversals are covered, whether or not their screens are mounted: a note created into a
 * project nobody is looking at still belongs in that project's list the next time it is opened. One
 * note's cached entity is deliberately not touched - a new note says nothing about an existing one,
 * and a write that is an edit will carry its own answer.
 */
export function invalidateResources(client: QueryClient, activation: number): Promise<void> {
  return inScope(client, activation, NOTES_SEGMENT);
}

/** A recording makes this session's media stale, for the connection it was captured under. */
export function invalidateSessionMedia(client: QueryClient, activation: number): Promise<void> {
  return inScope(client, activation, MEDIA_SEGMENT);
}
