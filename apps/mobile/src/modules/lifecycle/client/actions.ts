import { archive, restore } from '@raphael/client/nodes';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { asClientFailure, unwrap } from '../../../infrastructure/query/failure';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';
import { actionFailureSentence, type LifecycleVerb } from '../copy.ts';

/**
 * Archive and restore from a container screen: one request, then a re-read of everything.
 *
 * Shaped like `collections/client/active.ts::useProjectActive`, for the same reasons. The request
 * carries the revision the screen read, so a change made elsewhere since is refused rather than
 * overwritten. Nothing from the response is written into the cache: the container's own Get, read
 * again, is what shows the result - including a restore that leaves it archived through a container
 * above - so the screen never infers state from the verb it sent.
 *
 * The re-read is broad (`invalidateActivation`). Archiving changes which nodes every list, feed,
 * search and hierarchy read holds, and the phone cannot enumerate which cached reads that touches.
 *
 * Unlike the edit screen's lifecycle work, nothing here is durable. A container's lifecycle is one
 * bit of server state with nothing of the person's to protect, so a lost answer is reconciled by
 * reading, as the Active toggle does.
 */

const LIFECYCLE_WRITE = 'container-lifecycle';

export type LifecycleFailure = 'conflict' | 'unconfirmed' | 'failed' | null;

export interface LifecycleActionInput {
  readonly ref: ContainerRef;
  /** The revision the screen's own Get read. */
  readonly revision: number;
  readonly verb: LifecycleVerb;
}

export interface LifecycleAction {
  /** No-op while a request from this instance is running. */
  run(input: LifecycleActionInput): void;
  /** The request, and on success the re-read that follows it, are running. */
  readonly pending: boolean;
  /**
   * What became of this instance's last request: null until one fails, and cleared by the next. Per
   * instance, like `useProjectActive`'s verdict, so it goes when the screen does.
   */
  readonly failure: LifecycleFailure;
  /** `actionFailureSentence(failure)`, or null with no failure. */
  readonly failureMessage: string | null;
}

export function useLifecycleAction(): LifecycleAction {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;
  const mutation = useMutation({
    mutationKey: scopeKey(activation, LIFECYCLE_WRITE),
    // The session is captured from this render, so a request issued under one connection stays
    // addressed to it and its re-read lands under the activation it was stamped with.
    mutationFn: async ({ ref, revision, verb }: LifecycleActionInput) => {
      if (session === null) throw new Error('No connection');

      const send = verb === 'archive' ? archive : restore;

      return unwrap(await send(session.transport, { target: { id: ref.id }, revision }));
    },
    // Awaited, as the Active toggle's is: the toggle's busy ring is the only thing on screen, and it
    // should last until the state that replaces it has arrived. Ending it sooner would show the old
    // state for a moment, and a second press then would go out at the old revision and be refused as
    // a conflict with the person's own write. `invalidateQueries` resolves whichever way the
    // refetches settle, so a failed re-read never turns into a failed action.
    onSuccess: () => invalidateActivation(client, activation),
    // Not awaited. The request is settled, so the ring stops and the failure line says what happened
    // at once; the screen's own reads report how the re-read goes. A definite refusal is re-read too,
    // because the usual reason for one is that the container changed elsewhere.
    onError: () => {
      void invalidateActivation(client, activation);
    },
  });

  const failure = failureOf(mutation.error);

  return {
    run: (input) => {
      if (mutation.isPending) return;

      mutation.mutate(input);
    },
    pending: mutation.isPending,
    failure,
    failureMessage:
      failure === null ? null : actionFailureSentence(failure, messageOf(mutation.error)),
  };
}

const messageOf = (error: unknown): string =>
  asClientFailure(error)?.message ?? (error instanceof Error ? error.message : '');

const failureOf = (error: unknown): LifecycleFailure => {
  if (error === null || error === undefined) return null;

  const failure = asClientFailure(error);

  if (failure === null) return 'failed';
  if (failure.mutationOutcome === 'unknown') return 'unconfirmed';

  return failure.kind === 'api_error' && failure.error.code === 'revision_conflict'
    ? 'conflict'
    : 'failed';
};
