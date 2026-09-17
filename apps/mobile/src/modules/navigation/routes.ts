import { router } from 'expo-router';

import type { ContainerRef } from '../../infrastructure/api/contracts';

export { parseContainerRef, parseNodeId } from './refs';

/**
 * Every route this app can reach, in one place.
 *
 * Screens and sheets navigate through these helpers rather than writing hrefs, so a route file
 * that moves is renamed once here instead of in six features, and so the object form keeps the
 * generated `expo-router` types checking the parameters.
 *
 * Ids are numeric now. `refs.ts` owns turning a route parameter back into one, and is re-exported
 * here so callers have a single place to reach for.
 */

export function openArea(id: number): void {
  router.push({ pathname: '/area/[id]', params: { id: String(id) } });
}

export function openProject(id: number): void {
  router.push({ pathname: '/project/[id]', params: { id: String(id) } });
}

/**
 * Opens one saved note, read-only.
 *
 * By the server's numeric id, which is the only identity a note has. There is no draft route here:
 * a note that exists only on this phone is not addressable by a server id and is opened from the
 * record that holds it.
 */
export function openResource(id: number): void {
  router.push({ pathname: '/resource/[id]', params: { id: String(id) } });
}

/**
 * Opens the editor over one existing entity.
 *
 * One route for notes and containers alike: opening something is editing it, and the owner's own read
 * establishes which of the two it is, so the caller does not have to know. There is no read-only view
 * to fall back to and no mode to enter.
 *
 * **The cast is temporary and phase 07 owns removing it.** `expo-router` generates the union of
 * legal paths from the files in `src/app/`, and `src/app/edit/[id].tsx` lands with `EditScreen` in
 * phase 07 - so until then there is no honest type that names this path. Nothing calls this before
 * that file exists. The cast is deliberately scoped to the one call rather than widening the
 * helper's own parameter, so it disappears in a single line.
 */
export function openEditor(id: number): void {
  const href = { pathname: '/edit/[id]', params: { id: String(id) } };

  router.push(href as unknown as Parameters<typeof router.push>[0]);
}

/**
 * Opens the composer over one durable draft.
 *
 * By the draft's own identifier, which is the only identity writing that is not on a server has.
 * The route carries nothing else: no title, no destination and no payload, because a copy of a
 * record in navigation state is a copy that goes stale, and the owner holds the record.
 */
export function openCapture(draftId: string): void {
  router.push({ pathname: '/capture/[draftId]', params: { draftId } });
}

/** Opens an area or a project without the caller having to branch on its type. */
export function openContainer(ref: ContainerRef): void {
  if (ref.type === 'area') {
    openArea(ref.id);

    return;
  }

  openProject(ref.id);
}

/**
 * Opens Browse, the whole area and project tree, with `current` marked as where you are.
 *
 * Browse is a pushed screen rather than a sheet so a sheet can open over it. It is a card, not a
 * modal: on iOS a native modal sits above the sheets rendered in the root layout.
 */
export function openBrowse(current: ContainerRef | null = null): void {
  router.push({
    pathname: '/browse',
    params: current === null ? {} : { currentType: current.type, currentId: String(current.id) },
  });
}

/** Opens settings, where the server connection lives. */
export function openSettings(): void {
  router.push('/settings');
}

/** Opens the list of notes left unfinished on this phone. */
export function openRecovery(): void {
  router.push('/recovery');
}

/** Opens the screen that points this device at a different server. */
export function openChangeServer(): void {
  router.push('/change-server');
}

/** Opens the search modal, optionally limited to one container subtree. */
export function openSearch(scope: ContainerRef | null = null): void {
  router.push({
    pathname: '/search',
    params: scope === null ? {} : { scopeType: scope.type, scopeId: String(scope.id) },
  });
}

/** Lands on Home, replacing the current screen so a dead link does not stay in the back stack. */
export function openHome(): void {
  router.replace('/');
}

/**
 * Throws away everything on the stack and lands on Home.
 *
 * Used when the connection changes. Every route behind the current one names a container by id,
 * and those ids belong to the server that was connected when they were pushed - going back to one
 * after a switch would ask a different server for a container it has never heard of, or worse, for
 * one that happens to exist there and is something else entirely.
 */
export function resetToHome(): void {
  if (router.canDismiss()) router.dismissAll();

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
 * Closes the search modal and lands on the container, so the stack ends Home -> Area/Project.
 *
 * The dismissal is ordered before the push rather than fired alongside it: dismissing and pushing
 * in one frame lets the push land first on native, which leaves the modal sitting on top of the
 * screen it opened.
 */
export function leaveSearchFor(ref: ContainerRef): void {
  if (router.canDismiss()) router.dismissTo('/');

  openContainer(ref);
}
