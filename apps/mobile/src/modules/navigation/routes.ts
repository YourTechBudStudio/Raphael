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

/**
 * Opens Browse, the whole area and project tree, with `current` marked as where you are.
 *
 * Browse is a pushed screen rather than a sheet so the creation sheet can open over it. It is a
 * card, not a modal: on iOS a native modal sits above the sheets rendered in the root layout, and
 * "New area" from the root of the tree would open a sheet nobody could see.
 */
export function openBrowse(current: ParentRef | null = null): void {
  router.push({
    pathname: '/browse',
    params: current === null ? {} : { currentType: current.type, currentId: current.id },
  });
}

/**
 * Reads a collection reference out of route params, for the routes that take one as context:
 * a search scope, or the location Browse marks as current. Anything that is not a collection
 * reads as "none" rather than as an error, because a stale link is not the reader's mistake.
 */
export function parseCollectionRef(
  type: string | undefined,
  id: string | undefined,
): ParentRef | null {
  if (id === undefined || id === '') {
    return null;
  }

  return type === 'area' || type === 'project' ? { type, id } : null;
}

/** Opens settings, where the server connection lives. */
export function openSettings(): void {
  router.push('/settings');
}

/** Opens the screen that points this device at a different server. */
export function openChangeServer(): void {
  router.push('/change-server');
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
