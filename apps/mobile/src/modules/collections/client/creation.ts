/**
 * Creation, wired to the real database, the real client, and the real cache.
 *
 * The owner in `creation/owner.ts` takes everything platform-shaped through ports so a test can
 * drive all of it; this is the one place those ports become native SQLite, an HTTP request, and the
 * app's query client. The split is the same one `modules/connection` uses, and for the same reason:
 * every race worth testing lives on the far side of it.
 *
 * The store instance is module-scoped, which is what makes it app-scoped. One dispatcher for the
 * whole process, outliving every sheet that opens onto it.
 */

import { create as createNode } from '@raphael/client/nodes';
import type { CreateResponse } from '@raphael/contracts/nodes';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { queryClient } from '../../../infrastructure/query/query-client';
import { sqlDriver, SQLITE_SUPPORTED } from '../../../infrastructure/sqlite';
import { useConnectionSession, useConnectionStore } from '../../connection';
import { viewOf, type AttemptView } from '../creation/derive.ts';
import { createCreationOwner, type CreationSession } from '../creation/owner.ts';
import { ATTEMPTS_DATABASE } from '../creation/schema.ts';
import { openAttemptStore, type OpenOutcome } from '../creation/store.ts';
import { recordCreation } from './queries';

const now = () => Date.now();

/**
 * A random identifier for a local attempt and for an idempotency key.
 *
 * `expo-crypto`, not `globalThis.crypto`. This repository already records that `crypto.randomUUID`
 * is not reliably present on this runtime - `newConnectionId` says so and settles for `Math.random`
 * on the correct ground that nothing verifies a connection identity.
 *
 * An idempotency key is the opposite case. It is the only thing that can resolve an uncertain
 * creation, and two attempts drawing the same one would let a single key stand for two different
 * requests - the server would replay one as the other, or refuse it as a conflict. So this uses the
 * platform's real generator, which is present because it is a declared dependency rather than
 * because a global happened to be polyfilled.
 *
 * The provider is injected so the owner never reaches for a global, and a provider that throws
 * becomes an ordinary refusal rather than a rejected promise: `submit` catches it and answers
 * `not_recorded`, which leaves the form intact and says nothing was sent.
 */
const newId = (): string => randomUUID();

export const useCreationOwner = createCreationOwner({
  openStore: async (): Promise<OpenOutcome> => {
    if (!SQLITE_SUPPORTED) {
      return { kind: 'failed', message: 'This platform has no database for saved attempts.' };
    }

    return openAttemptStore(await sqlDriver.open(ATTEMPTS_DATABASE), now);
  },
  create: (transport, request) =>
    // The request is the frozen one, already decoded. The client decodes again, which is a fixed
    // point, so nothing is normalized twice into something different.
    createNode(transport, request as Parameters<typeof createNode>[1]),
  now,
  monotonic: () => performance.now(),
  newId,
  applyCreation: (response: CreateResponse, activation: number) =>
    recordCreation(queryClient, response, activation),
});

/** Opens the database once, as early as the app has a tree. Idempotent. */
export const useCreationStore = (): void => {
  const initialize = useCreationOwner((state) => state.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);
};

/** The connection an attempt would be made under, or null when there is none to make it with. */
export const useCreationSession = (): CreationSession | null => {
  const session = useConnectionSession();
  // A server that has refused this key, or answered in a protocol this build cannot read, is not
  // one to send a creation under. Sending anyway would burn a retry on an attempt that cannot
  // succeed, and the refusal would land on the record as though it said something about the
  // creation. The notice that asks someone to fix the connection is rendered elsewhere.
  const rejection = useConnectionStore((state) =>
    state.phase.kind === 'active' ? state.phase.rejection : null,
  );

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

/**
 * Every stored attempt, as something a screen can render.
 *
 * `now` is sampled per render rather than ticked, because nothing here changes second by second: a
 * 71-hour window does not need a timer, and one that re-rendered every second would be a timer
 * running for three days to change one label.
 */
export const useAttemptViews = (): readonly AttemptView[] => {
  const records = useCreationOwner((state) => state.records);
  const sending = useCreationOwner((state) => state.sending);
  // A server success whose local write failed is known, and the projection has to know it too -
  // otherwise the row, which is still at whatever state it was, reads as unresolved.
  const unsaved = useCreationOwner((state) => state.unsaved);
  const session = useCreationSession();
  const [sampledAt] = useState(() => now());

  return useMemo(
    () =>
      records.map((record) =>
        viewOf({
          record,
          confirmed: unsaved[record.attemptId],
          now: Math.max(now(), sampledAt),
          // Monotonic elapsed is known only inside the owner, which is where it is enforced. Here
          // it is absent, so the wall-clock reading decides what a screen offers - and the owner
          // re-checks with both before anything is actually sent.
          monotonicElapsedMs: null,
          sending: sending.includes(record.attemptId),
          activeConnectionId: session?.connectionId ?? null,
          connectionUsable: session?.usable ?? false,
          payloadUsable: record.lastOutcome?.kind !== 'unusable_payload',
        }),
      ),
    [records, sending, unsaved, session, sampledAt],
  );
};

/** The attempts made under the active connection, and those made under another one. */
export const useAttemptGroups = (): {
  readonly here: readonly AttemptView[];
  readonly elsewhere: readonly AttemptView[];
} => {
  const views = useAttemptViews();

  return useMemo(
    () => ({
      here: views.filter((view) => view.connected),
      elsewhere: views.filter((view) => !view.connected),
    }),
    [views],
  );
};

/** Discarding, dismissing, and retrying, bound to the owner so screens never hold it themselves. */
export const useAttemptActions = () => {
  const owner = useCreationOwner;
  const session = useCreationSession();

  const retry = useCallback(
    async (attemptId: string) => {
      if (session === null) {
        return { kind: 'refused' as const, problem: 'There is no connection to send this to.' };
      }

      return owner.getState().retry(attemptId, session);
    },
    [owner, session],
  );

  return {
    retry,
    discard: useCallback((attemptId: string) => owner.getState().discard(attemptId), [owner]),
    saveAcknowledgement: useCallback(
      (attemptId: string) => owner.getState().saveAcknowledgement(attemptId),
      [owner],
    ),
  };
};
