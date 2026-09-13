import { QueryCache, QueryClient, focusManager } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

import { shouldRetry } from './failure';

/**
 * The cache, configured for reading a live server rather than an in-memory mock.
 *
 * The mock never failed and never went stale, so the previous configuration turned everything off:
 * infinite freshness, no retries, no refetching. Every one of those is now wrong. A hierarchy can
 * change under the app, a request can fail for a moment and succeed the next, and a phone spends
 * most of its life with the app in the background.
 *
 * What is deliberate here:
 *
 * - A finite stale time, short enough that returning to a screen shows current data and long
 *   enough that moving between two screens does not refetch the same hierarchy twice.
 * - Retries decided by what actually failed, not by a count. `shouldRetry` refuses to repeat a
 *   refused key or a protocol mismatch, which are settled answers rather than bad luck.
 * - Refetch on mount and on focus, but only when the data is stale. Returning to the app is
 *   exactly when a cached hierarchy is most likely to be out of date, and the bridge below is what
 *   turns "the app came to the foreground" into the focus event React Query expects from a tab.
 *
 * `refetchOnReconnect` is set, and on this runtime it currently fires for nothing: React Query's
 * online manager needs a network-state provider to report a reconnection, and this app does not
 * install one. Recovery from being offline therefore comes from foreground focus and from explicit
 * retry, not from the radio coming back. The flag is left true so that adding a provider later
 * needs no change here, and it is recorded rather than relied on.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      failureListener?.(error, query.queryKey);
    },
  }),
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

type FailureListener = (error: unknown, queryKey: readonly unknown[]) => void;

let failureListener: FailureListener | null = null;

/**
 * Lets one capability watch every query failure without this file knowing which one.
 *
 * The connection capability needs to hear about a refused key wherever it surfaces, not only on
 * the screen that happened to ask. Having it subscribe keeps the dependency pointing the right
 * way: infrastructure knows a listener exists, and nothing more. The failing query's key travels
 * with the error so the listener can tell which connection the failure belongs to, and ignore one
 * that arrives from a connection that is no longer active.
 */
export const setQueryFailureListener = (listener: FailureListener | null): void => {
  failureListener = listener;
};

/**
 * React Query's focus and online managers assume a browser. On a phone, foreground is the focus
 * event that matters, and it is what makes a stale hierarchy refresh when someone comes back to
 * the app rather than showing them what was true an hour ago.
 */
export const startAppStateBridge = (): (() => void) => {
  const onChange = (status: AppStateStatus): void => {
    focusManager.setFocused(status === 'active');
  };

  const subscription = AppState.addEventListener('change', onChange);
  onChange(AppState.currentState);

  return () => {
    subscription.remove();
  };
};
