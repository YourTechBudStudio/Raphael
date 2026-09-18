/**
 * The edit owner, wired to the real database, the real client, and the real cache.
 *
 * `client/owner.ts`'s counterpart, and deliberately the same shape: the owner in `../edit-owner.ts`
 * takes everything platform-shaped through ports so a test can drive all of it, and this is the one
 * place those ports become Expo SQLite, an HTTP request, and the app's query client.
 *
 * It opens the **same** database as the creation owner, through `store-lifetime.ts`. That is the rule
 * capture is held to - one capability opens a local operational database, and it opens it once - and
 * it is why editing lives inside capture as a second owner rather than beside it as a capability with
 * a database of its own.
 */

import { get as getNode, update as updateNode } from '@raphael/client/nodes';
import { useEffect } from 'react';

import { queryClient } from '../../../infrastructure/query/query-client';
import { useConnectionStore } from '../../connection';
import { createEditOwner } from '../edit-owner.ts';
import { openSharedStore } from './store-lifetime.ts';
import { applyUpdateTo } from './update-cache.ts';

export const useEditOwner = createEditOwner({
  // One open of the capture database, shared with the creation owner. See `store-lifetime.ts`.
  openStore: openSharedStore,
  get: (transport, request) => getNode(transport, request),
  update: (transport, request) => updateNode(transport, request),
  now: () => Date.now(),
  // One consequence of one editing session, bound to the app's cache. Which queries it touches is
  // decided in `update-cache.ts`, where it can be driven without a connection.
  applyUpdate: (ref, activation) => applyUpdateTo(queryClient, ref, activation),
  /**
   * The same question, and the same answer, as the creation owner's.
   *
   * Read from the live store rather than from a React value, because the loop dispatches from a timer
   * rather than from a render, and a rendered session is a session as of the last render. The
   * activation is what catches a credential rotation against the same address: the connection id
   * survives one by design.
   */
  sessionIsCurrent: (session) => {
    const phase = useConnectionStore.getState().phase;

    return phase.kind === 'active' && phase.session.activation === session.activation;
  },
});

/**
 * Read the edit records once, for the whole process.
 *
 * Mounted beside `useCaptureLifetime`, above the connection gate, so an answer that arrives after
 * someone navigates away still has an owner to be written against and unsent edits are countable
 * before anything asks. It opens no route and shows nothing.
 */
export const useEditLifetime = (): void => {
  const initialize = useEditOwner((state) => state.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);
};
