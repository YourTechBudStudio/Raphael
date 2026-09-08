import { QueryClient } from '@tanstack/react-query';

/**
 * The mock repository never fails and never goes stale on its own, so retries and
 * background refetching would only add noise.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: { retry: false },
  },
});
