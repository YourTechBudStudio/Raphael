/**
 * The router, recording rather than navigating.
 *
 * Route helpers are product code and are tested through what they ask the router for. Nothing here
 * renders a route.
 */

export const navigations = [];

export const resetNavigations = () => {
  navigations.length = 0;
  params = {};
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

let params = {};

/** What the route being rendered was opened with. Reset with `resetNavigations`. */
export const setLocalSearchParams = (next) => {
  params = next;
};

export const useLocalSearchParams = () => params;
