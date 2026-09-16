/**
 * What a write does to what is cached.
 *
 * Three operations, all activation-scoped, all free of React and of the connection store so they can
 * be driven directly. The scoping is the point: the predicate these replaced matched a key segment
 * alone, so a write against one server marked a retired server's caches stale - through a transport
 * that is gone, into keys nothing reads.
 */

import type { QueryClient } from '@tanstack/react-query';

import { activationOf } from '../../../infrastructure/query/keys.ts';
import type { NoteEntity } from './entity.ts';
import { noteEntityKey, NOTES_SEGMENT } from './requests.ts';

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

/**
 * Remembers a note this connection just created, but only where nothing is remembered already.
 *
 * Absent-only for the reason container creation is: a create response can be a *replay* of an
 * earlier attempt under the same key, and what it reports is the entity as it was when that attempt
 * was first answered - which may be days old. Writing it over a cached reading could therefore
 * replace a current note with an older snapshot of itself. Writing only where the cache is empty can
 * never do that, and the worst case is one Get that was not saved.
 *
 * It seeds; it does not prepend. A replayed receipt is not news about the feed's ordering, so the
 * feed is invalidated and re-read rather than having an entity spliced into its first page.
 */
export function seedNoteDetail(client: QueryClient, activation: number, entity: NoteEntity): void {
  const key = noteEntityKey(activation, entity.id);
  if (client.getQueryData(key) !== undefined) return;

  client.setQueryData(key, entity);
}
