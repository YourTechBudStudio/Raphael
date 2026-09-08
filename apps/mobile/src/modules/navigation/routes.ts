import { router } from 'expo-router';

import type { Collection, ParentRef, SearchScope } from '../../infrastructure/api/contracts';

/**
 * Every route this app can reach, in one place.
 *
 * Screens and sheets navigate through these helpers rather than writing hrefs, so a route file
 * that moves is renamed once here instead of in six features, and so the object form keeps the
 * generated `expo-router` types checking the parameters.
 */

export function openArea(id: string): void {
  router.push({ pathname: '/area/[id]', params: { id } });
}

export function openProject(id: string): void {
  router.push({ pathname: '/project/[id]', params: { id } });
}

/** Opens an area or a project without the caller having to branch on its type. */
export function openCollection(collection: Collection | ParentRef): void {
  if (collection.type === 'area') {
    openArea(collection.id);

    return;
  }

  openProject(collection.id);
}

/** Opens the search modal, optionally limited to one collection subtree. */
export function openSearch(scope: SearchScope = null): void {
  router.push({
    pathname: '/search',
    params: scope === null ? {} : { scopeType: scope.type, scopeId: scope.id },
  });
}

/** Lands on Home, replacing the current screen so a dead link does not stay in the back stack. */
export function openHome(): void {
  router.replace('/');
}

/** Leaves the current screen, or lands on Home when it was opened directly by a deep link. */
export function goBack(): void {
  if (router.canGoBack()) {
    router.back();

    return;
  }

  openHome();
}

/**
 * Closes the search modal and lands on the collection, so the stack ends Home -> Area/Project.
 *
 * The dismissal is ordered before the push rather than fired alongside it: dismissing and
 * pushing in one frame lets the push land first on native, which leaves the modal sitting on
 * top of the screen it opened.
 */
export function leaveSearchFor(collection: Collection): void {
  if (router.canDismiss()) {
    router.dismissTo('/');
  }

  openCollection(collection);
}
