import { update } from '@raphael/client/nodes';
import type { RecoveryDetails } from '@raphael/contracts';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../../../infrastructure/query/failure';
import { scopeKey } from '../../../infrastructure/query/keys';
import { useConnectionSession } from '../../connection';
import { invalidateContainer, invalidateHierarchy } from './queries';

/**
 * Marking a project as being worked on, as server state.
 *
 * This used to be a list of ids in a module-level map: it died with the process, an explicit
 * disconnect erased it on purpose, no other client could see it, and the write validated nothing.
 * It is now one boolean on the project's own row, written through the `nodes.update` operation that
 * already exists, under the revision the screen was looking at.
 *
 * Three ideas carry the whole design.
 *
 * **A write carries the revision the person was looking at.** That is why callers pass an
 * `ActiveTarget` rather than an id: the state and the revision travel together, from the same
 * reading, so a stale caller is told the row moved instead of silently undoing a decision it never
 * saw. Home can do this because the hierarchy now carries `revision` through projection.
 *
 * **The wire field is desired state, never a toggle.** `active: true` means "the resulting state is
 * active". Two clients sending `true` from the same revision are harmless.
 *
 * **Reconciliation is a re-read, never a local record.** A boolean carries nothing to preserve, so
 * one rule covers every outcome - success, a definite refusal, and a genuinely uncertain result
 * alike: read the entity back. That is why nothing here resembles `capture/edit-owner.ts`'s durable
 * store, and why the update's own response is never written into the cache.
 *
 * Everything is scoped to one activation: the mutation key, the intent read from it, and both
 * invalidations. A write answered under a connection the app has since left cannot mark the current
 * connection's data stale, which is the same rule `queries.ts` states for the hierarchy.
 */

const ACTIVE_WRITE = 'set-project-active';

interface ActiveInput {
  readonly id: number;
  readonly revision: number;
  readonly active: boolean;
}

export interface ActiveTarget {
  readonly id: number;
  /** The revision the screen read this state at. */
  readonly revision: number;
  /** The state the screen read. */
  readonly active: boolean;
}

/**
 * `archived` is the server refusing because the project, or an area above it, was archived elsewhere
 * while this screen showed it active. `failureDetails` carries what it is worded from.
 */
export type ActiveFailure = 'conflict' | 'failed' | 'archived' | null;

export interface ProjectActive {
  /** Pending intent for this id, else the state the caller read. */
  isActive(target: ActiveTarget): boolean;
  /** A write for this id is pending, including its awaited re-read. */
  isDisabled(id: number): boolean;
  /** Sends the opposite of `isActive(target)` against `target.revision`. No-op while disabled. */
  toggle(target: ActiveTarget): void;
  /**
   * Verdict of the last write issued through this instance: null until its first write, held after a
   * refusal until this instance's next dispatch, null again after a later success from it.
   *
   * One instance per control, deliberately. A `useMutation` observer reports only its most recent
   * dispatch - it detaches from the previous mutation before building the next - so a single
   * screen-level instance driving several cards would lose card A's conflict the moment card B
   * dispatched, which is an ordinary sequence here because toggles run independently. Pending intent
   * and `isDisabled` do not have this problem: they read the mutation *cache*, which holds every
   * in-flight write at once.
   *
   * Unmounting a control drops its verdict with it. That is preferred over deriving verdicts from
   * the cache, where a settled error lingers for its `gcTime` and would resurrect a stale sentence
   * when the control came back.
   */
  readonly failure: ActiveFailure;
  /** The server's details for that refusal, or null with no failure. */
  readonly failureDetails: RecoveryDetails | null;
}

/**
 * One control's view of the selection, and its own write.
 *
 * The pending intent is shared - it is read from the mutation cache, not from this observer - so
 * Home and the Project screen agree about what is in flight even though each holds its own
 * instance. Only the verdict is per-instance, for the reason above.
 */
export function useProjectActive(): ProjectActive {
  const session = useConnectionSession();
  const client = useQueryClient();
  const activation = session?.activation ?? -1;
  const writeKey = scopeKey(activation, ACTIVE_WRITE);
  const pending = useMutationState({
    filters: { mutationKey: writeKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as ActiveInput,
  });
  const mutation = useMutation({
    mutationKey: writeKey,
    // The session is captured from this render rather than read when the request runs, the same rule
    // `queries.ts` follows for the hierarchy: a write issued under one connection stays addressed to
    // that connection's transport, and lands under the activation its key was stamped with.
    mutationFn: async ({ id, revision, active }: ActiveInput) => {
      if (session === null) throw new Error('No connection');

      return unwrap(await update(session.transport, { target: { id }, revision, active }));
    },
    // Awaited, though `capture/update-cache.ts` says an invalidation never gates a verdict. That rule
    // protects a save receipt shown separately from the lists it refreshes; holding it open would
    // report an accepted write as still in progress. A toggle has no separate verdict: the control's
    // own pending state is the only thing on screen, and it is exactly what should persist until the
    // truth that replaces it has arrived. So the mutation stays pending until both re-reads land, the
    // control stays disabled and busy showing the state the server already accepted, and a second tap
    // cannot be issued against the pre-toggle revision - which is what stops a person's own
    // successful write from becoming the conflicting party.
    //
    // Awaiting does not turn a failed refetch into a failed write: `invalidateQueries` resolves when
    // the refetches settle, whichever way they settle.
    onSuccess: async (_response, { id }) => {
      await Promise.all([
        invalidateContainer(client, activation, { type: 'project', id }),
        invalidateHierarchy(client, activation),
      ]);
    },
    // Not awaited, and that asymmetry is the point. The write is settled, so the intent should clear
    // at once: the screen reverts to what it last read and says why, and the re-read corrects it when
    // it lands rather than holding the explanation back until it does.
    onError: (_error, { id }) => {
      void invalidateContainer(client, activation, { type: 'project', id });
      void invalidateHierarchy(client, activation);
    },
    // Paths are not invalidated: no title changed.
  });

  const intentFor = (id: number): ActiveInput | undefined =>
    pending.findLast((input) => input.id === id);

  const isActive = (target: ActiveTarget): boolean => intentFor(target.id)?.active ?? target.active;

  const isDisabled = (id: number): boolean => intentFor(id) !== undefined;

  return {
    isActive,
    isDisabled,
    toggle: (target: ActiveTarget) => {
      if (isDisabled(target.id)) return;

      mutation.mutate({
        id: target.id,
        revision: target.revision,
        active: !isActive(target),
      });
    },
    // Read from this observer rather than held in state: React Query resets it on the next dispatch
    // and clears it on success, which is precisely the lifecycle documented above. A separate
    // `useState` plus a clearing effect would be a second copy of the same fact.
    //
    // The conflict test is the one `capture/edit-owner.ts` uses, so both places agree about what the
    // server saying "the row moved" looks like. Mutations do not retry (`query-client.ts`), so a
    // definite refusal is reported once.
    failure: failureOf(mutation.error),
    failureDetails: detailsOf(mutation.error),
  };
}

const detailsOf = (error: unknown): RecoveryDetails | null => {
  const failure = asClientFailure(error);

  return failure?.kind === 'api_error' ? failure.details : null;
};

const failureOf = (error: unknown): ActiveFailure => {
  if (error === null || error === undefined) return null;

  const failure = asClientFailure(error);

  if (failure?.kind !== 'api_error') return 'failed';
  if (failure.error.code === 'revision_conflict') return 'conflict';

  return failure.error.code === 'node_archived' ? 'archived' : 'failed';
};
