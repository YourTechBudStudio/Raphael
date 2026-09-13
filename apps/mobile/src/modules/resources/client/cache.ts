import { useQuery, type QueryClient } from '@tanstack/react-query';

import { localContent } from '../../../infrastructure/api';
import type { Resource } from '../../../infrastructure/api/contracts';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';

/**
 * Every note this session holds, read once and filtered by whoever needs a subset.
 *
 * There used to be four queries over this data - a home feed, an area's notes, a project's notes,
 * and a search - each asking the boundary its own question. That was reasonable against a
 * repository that could answer them; against one in-memory list it is four cached copies of the
 * same fact that can disagree after a write, and four things to remember to invalidate. One query,
 * filtered at the point of use, cannot drift from itself.
 *
 * These notes are session-only. Nothing here reaches a server, and no screen may say they are saved.
 */

const RESOURCES = 'local-resources';

export function useLocalResources() {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;

  return useQuery({
    queryKey: scopeKey(session?.activation ?? -1, RESOURCES),
    queryFn: (): Promise<Resource[]> => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.getResources(connectionId);
    },
    enabled: connectionId !== null,
  });
}

/** A successful capture makes every view of these notes stale. */
export function invalidateResources(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => query.queryKey[2] === RESOURCES });
}
