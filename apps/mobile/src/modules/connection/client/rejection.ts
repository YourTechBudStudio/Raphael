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

import { useEffect } from 'react';

import { asClientFailure, connectionRejectionOf } from '../../../infrastructure/query/failure';
import { activationOf } from '../../../infrastructure/query/keys';
import { setQueryFailureListener } from '../../../infrastructure/query/query-client';
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
