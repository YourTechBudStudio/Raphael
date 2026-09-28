/**
 * Hearing about a refused key wherever it happens, not only on the screen that asked.
 *
 * A connection-level refusal is not a property of the query that happened to run into it. If the
 * server stops accepting this key, every read fails, and the app owes the person one clear
 * statement about the connection rather than the same red box on four screens. So the cache
 * reports failures here, and this decides which of them are about the connection at all.
 *
 * The fencing is the failing query's own key. Each carries the activation it was issued under, so
 * a 401 from the connection before last - which can still be in flight when a new one is
 * established - is recognised as belonging to a connection that is no longer current and is
 * dropped. Without that, changing servers because the old key was refused would immediately mark
 * the new connection as refused too.
 *
 * Nothing here deletes a credential or navigates. It records; the screens decide what to offer.
 */

import type { ClientFailure } from '@raphael/client';
import { verify } from '@raphael/client/connection';
import { useEffect, useState } from 'react';

import { asClientFailure, connectionRejectionOf } from '../../../infrastructure/query/failure';
import { activationOf } from '../../../infrastructure/query/keys';
import { queryClient, setQueryFailureListener } from '../../../infrastructure/query/query-client';
import { useConnectionStore } from '../state/connection';

export function useRejectionWatch(): void {
  useEffect(() => {
    setQueryFailureListener((error, queryKey) => {
      const failure = asClientFailure(error);

      if (failure === null) return;

      const rejection = connectionRejectionOf(failure);
      const activation = activationOf(queryKey);

      if (rejection === null || activation === null) return;

      useConnectionStore.getState().noteRejection(activation, rejection);
    });

    return () => {
      setQueryFailureListener(null);
    };
  }, []);
}

/**
 * Trying again after a refusal: ask the server once, and take the refusal down only when it has
 * accepted this phone.
 *
 * Clearing first and letting the screen's queries find out would say "connected" before anything
 * was checked, and on a screen with no queries nothing would ever check. So the check is explicit,
 * and while it runs the refusal stays up and the button says it is checking.
 *
 * A check that gets no clear answer - the network, a server error - leaves the refusal standing.
 * Nothing is known to have changed, and reachability says so separately if the server is away.
 *
 * Only the newest check's answer counts. The notice can be mounted on more than one screen at once
 * - Settings sits over Home - so two checks can overlap, and an older answer arriving last must not
 * overwrite what a newer one said.
 */
let latestRetry = 0;

export function useRejectionRetry(): { readonly checking: boolean; readonly retry: () => void } {
  const [checking, setChecking] = useState(false);

  const retry = (): void => {
    const { phase } = useConnectionStore.getState();

    if (checking || phase.kind !== 'active') return;

    const { activation, transport } = phase.session;
    const attempt = ++latestRetry;

    setChecking(true);
    void verify(transport)
      .then((result) => {
        if (attempt !== latestRetry) return;

        const store = useConnectionStore.getState();

        if (!result.ok) {
          const rejection = connectionRejectionOf(result.failure as ClientFailure);

          if (rejection !== null) store.noteRejection(activation, rejection);
          return;
        }

        // An answer for a connection that has since been replaced says nothing about this one.
        if (store.phase.kind !== 'active' || store.phase.session.activation !== activation) return;

        store.clearRejection();
        // Whatever the screens showed failed under the refusal; now they can read it again.
        void queryClient.refetchQueries();
      })
      .finally(() => {
        setChecking(false);
      });
  };

  return { checking, retry };
}
