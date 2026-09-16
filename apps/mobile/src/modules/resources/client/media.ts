import { useQuery } from '@tanstack/react-query';

import { localContent } from '../../../infrastructure/api';
import type { Resource } from '../../../infrastructure/api/contracts';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';
import { MEDIA_SEGMENT } from './cache.ts';

/**
 * Media captured in this session: voice, and the image and repository cards beside it.
 *
 * This query used to serve notes as well, and the difference is the whole point of splitting it.
 * Notes are on the server now and are read from it; these have no server operation at all, exist
 * only in this process, and vanish with it. Presenting them in the same section as server notes
 * would make one sentence - "here is what you have" - cover two things with completely different
 * guarantees, so they get their own section and their own honest label.
 *
 * Session-only. Nothing here reaches a server, and no screen may say it is saved.
 */

export function useSessionMedia() {
  const session = useConnectionSession();
  const connectionId = session?.connection.connectionId ?? null;

  return useQuery({
    queryKey: scopeKey(session?.activation ?? -1, MEDIA_SEGMENT),
    queryFn: (): Promise<Resource[]> => {
      if (connectionId === null) throw new Error('No connection');

      return localContent.getResources(connectionId);
    },
    enabled: connectionId !== null,
  });
}
