/**
 * The router, recording rather than navigating.
 *
 * Route helpers are product code and are tested through what they ask the router for. Nothing here
 * renders a route.
 */

export const navigations = [];

export const resetNavigations = () => {
  navigations.length = 0;
};

const record = (method) => (target) => {
  navigations.push({ method, target });
};

export const router = {
  push: record('push'),
  replace: record('replace'),
  back: record('back'),
  dismissTo: record('dismissTo'),
  dismissAll: record('dismissAll'),
  canGoBack: () => false,
  canDismiss: () => false,
};

export const useLocalSearchParams = () => ({});
