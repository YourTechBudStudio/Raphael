/**
 * What a created note does to what is cached.
 *
 * Its own file, and taking the client as a parameter, so the one consequence a creation has on the
 * cache can be driven without a connection.
 *
 * **It seeds nothing.** It used to file the created entity under a note-detail key, and that key is
 * gone: opening a note is editing it, the editor reads through the edit owner's own Get, and a cached
 * entity beside that read would be a second authority on what one note says. What is left is the
 * invalidation, which was always the half that mattered for a feed.
 *
 * **The refresh is not awaited, and that is the point.** The half that matters happens
 * synchronously: `invalidateQueries` marks its queries stale before it returns a promise. What that
 * promise then waits for is the *active refetches* - reads of a feed that may retry, time out, or
 * simply be slow. Awaiting them would keep a creation the server has already answered for reported as
 * still in progress, with the composer locked and saying "Saving…" while an unrelated list reloads. A
 * save is established by the server's answer and by this phone's record of it; a refresh is a
 * consequence, and consequences do not gate verdicts.
 *
 * Its failure is caught here for the same reason. The owner also treats a rejection as a failed
 * refresh rather than a failed save, so this loses no diagnostic it was carrying - it stops one
 * escaping as an unhandled rejection now that nothing downstream is waiting on it.
 */

import type { QueryClient } from '@tanstack/react-query';

import { invalidateResources } from '../../resources';

/** Marks every view of this connection’s notes stale. Activation-scoped by the function itself. */
export const applyCreationTo = (client: QueryClient, activation: number): Promise<void> => {
  void invalidateResources(client, activation).catch(() => {
    // A failed refresh, never a failed save. The next ordinary read corrects a stale feed.
  });

  return Promise.resolve();
};
