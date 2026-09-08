import { useQuery } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import { resourceViewMeta } from '../../resources';

/** The most recent resources across every collection. */
export function useHomeFeed() {
  return useQuery({
    queryKey: ['home-feed'],
    queryFn: () => mobileApi.getHomeFeed(),
    meta: resourceViewMeta,
  });
}
