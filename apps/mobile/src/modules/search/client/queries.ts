import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { mobileApi } from '../../../infrastructure/api';
import type { SearchScope } from '../../../infrastructure/api/contracts';
import { resourceViewMeta } from '../../resources';

/** Keep previous results visible while a refined query is loading. */
export function useSearch(query: string, scope: SearchScope) {
  return useQuery({
    queryKey: ['search', query, scope === null ? 'all' : `${scope.type}:${scope.id}`],
    queryFn: () => mobileApi.search(query, scope),
    meta: resourceViewMeta,
    enabled: query.trim() !== '',
    placeholderData: keepPreviousData,
  });
}
