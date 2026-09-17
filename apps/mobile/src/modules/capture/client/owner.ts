/**
 * The capture owner, wired to the real database, the real client, and the real cache.
 *
 * The owner in `../owner.ts` takes everything platform-shaped through ports so a test can drive all
 * of it; this is the one place those ports become Expo SQLite, an HTTP request, and the app's query
 * client. The split is the one `modules/connection` uses, and for the same reason: every race worth
 * testing lives on the far side of it.
 *
 * The store instance is module-scoped, which is what makes it app-scoped. **One dispatcher for the
 * whole process, above the connection gate.** That placement is deliberate and is not a convenience:
 * a response arriving after the connection was retired still has to be classified and written
 * against its original attempt, and an owner that lived inside the connected branch would be torn
 * down by the very event that makes that answer interesting. What the gate decides is what a person
 * may *see*; what this decides is what is *recorded*, and those are different questions.
 */

import { create as createNode } from '@raphael/client/nodes';
import { randomUUID } from 'expo-crypto';
import { useEffect, useMemo } from 'react';

import { queryClient } from '../../../infrastructure/query/query-client';
import { useConnectionSession, useConnectionStore } from '../../connection';
import { createCaptureOwner, type CaptureSession } from '../owner.ts';
import { applyCreationTo } from './creation-cache.ts';
import { openSharedStore } from './store-lifetime.ts';

const now = () => Date.now();

/**
 * A random identifier for a draft, an attempt, and an idempotency key.
 *
 * `expo-crypto`, not `globalThis.crypto`. A key drawn twice would let one key stand for two
 * different requests, and the server would then replay one as the other or refuse it as a conflict.
 * The provider is injected so the owner never reaches for a global, and a provider that throws
 * becomes an ordinary refusal rather than a rejected promise nothing is listening to.
 */
const newId = (): string => randomUUID();

export const useCaptureOwner = createCaptureOwner({
  // One open of the capture database, shared with every other owner over it. See `store-lifetime.ts`.
  openStore: openSharedStore,
  create: (transport, request) =>
    // The request is the frozen one, already decoded. The client decodes again, which is a fixed
    // point, so nothing is normalized twice into something different.
    createNode(transport, request as Parameters<typeof createNode>[1]),
  now,
  monotonic: () => performance.now(),
  newId,
  // One consequence of one event, bound to the app's cache. What may be filed as a note's detail is
  // decided in `creation-cache.ts`, where it can be driven without a connection.
  applyCreation: (response, activation) => applyCreationTo(queryClient, response, activation),
  /**
   * Whether this session is the one the app is working under right now.
   *
   * Read from the live store rather than from a React value, because admission is synchronous and a
   * rendered session is a session as of the last render. The activation is what catches a credential
   * rotation against the same address: the connection id survives one by design.
   */
  sessionIsCurrent: (session) => {
    const phase = useConnectionStore.getState().phase;

    return phase.kind === 'active' && phase.session.activation === session.activation;
  },
});

/**
 * Open the database once, for the whole process.
 *
 * Mounted above the connection gate, so drafts and attempts are readable before anything asks about
 * them and a late answer has somewhere to be written. It opens no route and shows nothing: what a
 * person may see is the gate's decision, not this one.
 */
export const useCaptureLifetime = (): void => {
  const initialize = useCaptureOwner((state) => state.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);
};

/** The connection an operation would be performed under, or null when there is none. */
export const useCaptureSession = (): CaptureSession | null => {
  const session = useConnectionSession();
  // A server that has refused this key, or answered in a protocol this build cannot read, is not
  // one to send a note under: the refusal would land on the record as though it said something
  // about the creation. The notice asking someone to fix the connection is rendered elsewhere.
  const rejection = useConnectionStore((state) =>
    state.phase.kind === 'active' ? state.phase.rejection : null,
  );

  // Memoized because it is an effect dependency and an admission argument in several places: a
  // fresh object every render would restart effects that have nothing to do with the connection.
  return useMemo(
    () =>
      session === null
        ? null
        : {
            activation: session.activation,
            connectionId: session.connection.connectionId,
            endpoint: session.connection.origin,
            transport: session.transport,
            usable: rejection === null,
          },
    [session, rejection],
  );
};
