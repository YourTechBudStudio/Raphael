/**
 * What a created note does to what is cached.
 *
 * Its own file, and taking the client as a parameter, because this is the one piece of the
 * composition with a decision in it: **which responses may be filed as a note's detail**. Everything
 * else in `owner.ts` is wiring that can only be read, but this can be wrong quietly - a container's
 * entity written under a note's detail key would be handed to the note screen as though the server
 * had said it, and nothing downstream would question it.
 *
 * The guard is the exact invariant rather than a proxy for it. `kind !== null` happens to be true of
 * every note today, because containers carry a null kind - but it is true of every future resource
 * kind as well, and a cast past it would make the compiler stop asking. Naming both halves means a
 * widened server vocabulary cannot become a note by omission.
 */

import type { CreateResponse } from '@raphael/contracts/nodes';
import type { QueryClient } from '@tanstack/react-query';

import { invalidateResources, seedNoteDetail } from '../../resources';

/**
 * Seed the note's detail where nothing is cached, then mark the feeds stale.
 *
 * Both halves are activation-scoped by the functions themselves, so a completion from a connection
 * this app has left seeds and invalidates nothing that is on screen. Seeding is absent-only: a
 * create response can be a replay of an earlier attempt and report the entity as it was when that
 * attempt was first answered, so writing it over a cached reading could replace a current note with
 * an older snapshot of itself.
 *
 * **The refetch is not awaited, and that is the point.** Both halves that matter happen
 * synchronously: the entity is seeded, and `invalidateQueries` marks its queries stale before it
 * returns a promise. What that promise then waits for is the *active refetches* - reads of a feed
 * that may retry, time out, or simply be slow. Awaiting them would keep a creation the server has
 * already answered for reported as still in progress, with the composer locked and saying
 * "Saving…" while an unrelated list reloads. A save is established by the server's answer and by
 * this phone's record of it; a refresh is a consequence, and consequences do not gate verdicts.
 *
 * Its failure is caught here for the same reason. The owner also treats a rejection as a failed
 * refresh rather than a failed save, so this loses no diagnostic it was carrying - it stops one
 * escaping as an unhandled rejection now that nothing downstream is waiting on it.
 */
export const applyCreationTo = (
  client: QueryClient,
  response: CreateResponse,
  activation: number,
): Promise<void> => {
  const entity = response.entity;

  if (entity.type === 'resource' && entity.kind === 'note') {
    seedNoteDetail(client, activation, entity);
  }

  void invalidateResources(client, activation).catch(() => {
    // A failed refresh, never a failed save. The next ordinary read corrects a stale feed.
  });

  return Promise.resolve();
};
