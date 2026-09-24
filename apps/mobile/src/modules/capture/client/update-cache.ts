/**
 * What an acknowledged edit or move does to what is cached.
 *
 * Its own file, and taking the client as a parameter, for the reason `creation-cache.ts` is: this is
 * the one piece of the composition with a decision in it, and it can be wrong quietly.
 *
 * **The update response is never written into the cache.** It is invalidated, and the next read is the
 * single authority on what the server holds. Writing the response would make an update a second
 * authority on ordering: two phones editing the same entity would each file their own answer over the
 * other's, and the cache would settle on whichever request happened to finish last rather than on
 * whichever write the server applied last. Invalidating removes that hazard rather than mitigating it,
 * at the cost of one refetch per editing session.
 *
 * **One consequence per editing session**, fired by the owner when the editor leaves or when an
 * acknowledgement lands with nobody attached - not once per acknowledgement. The owner owns that
 * gating; this owns which queries a consequence touches.
 */

import type { NodeType } from '@raphael/contracts/nodes';
import type { QueryClient } from '@tanstack/react-query';

import { invalidateContainer, invalidateHierarchy, invalidatePaths } from '../../collections';
import { invalidateResources } from '../../resources';

/**
 * Mark everything an edit of `ref` could have made stale, for the connection it was made under.
 *
 * Every branch is activation-scoped by the function it calls, so an answer from a connection this app
 * has left invalidates nothing that is on screen. Nothing is awaited: `invalidateQueries` marks its
 * queries stale before it returns a promise, and what that promise then waits for is the active
 * refetches. Holding a save's verdict open while an unrelated list reloads would report writing the
 * server has already accepted as still in progress.
 *
 * A note invalidates the note feeds only. There is deliberately no note-detail invalidation: the
 * editor reads through the owner, so the detail query has no reader left.
 *
 * A container invalidates three things, because a container is read in three shapes: its own entity,
 * the hierarchy every screen draws its tree from, and the canonical paths the server composes from its
 * ancestors' slugs, which a move or a slug change alters for everything beneath it.
 */
export const applyUpdateTo = (
  client: QueryClient,
  ref: { readonly type: NodeType; readonly id: number },
  activation: number,
): Promise<void> => {
  const swallow = (): void => {
    // A failed refresh, never a failed save. The next ordinary read corrects a stale screen.
  };

  if (ref.type === 'resource') {
    void invalidateResources(client, activation).catch(swallow);

    return Promise.resolve();
  }

  void invalidateContainer(client, activation, { type: ref.type, id: ref.id }).catch(swallow);
  void invalidateHierarchy(client, activation).catch(swallow);
  void invalidatePaths(client, activation).catch(swallow);

  return Promise.resolve();
};
