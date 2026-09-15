/**
 * The one thing that sends a creation, and the only thing allowed to.
 *
 * It is app-scoped rather than sheet-scoped, and that is the design rather than a convenience. A
 * dispatcher that lived in the sheet would be destroyed when the sheet closed, so an answer arriving
 * after someone swiped down would have nowhere to be written; reopening the sheet would build a
 * second dispatcher for the same attempt; and a connection switch mid-flight would leave a result
 * with no owner at all. Concurrency is prevented here, by an in-flight set keyed on the durable
 * attempt id - a disabled button is a hint, not an invariant.
 *
 * The order of writes is the whole discipline, and it is the same in every path:
 *
 *   persist, then send. A local write that fails means nothing was sent, and says so.
 *   persist the answer, then present it. A success nobody wrote down is a success that is lost.
 *   delete only what has been consumed. Cleanup never depends on a refresh succeeding.
 *
 * The store holds evidence; this holds the rules. A row cannot enforce a legal transition on its
 * own, and every rule that decides whether an attempt may be sent lives in one expression here and
 * in `viewOf`, not spread across the components that draw the buttons.
 */

import type { ClientFailure, ClientResult } from '@raphael/client';
import type { CreateResponse } from '@raphael/contracts/nodes';
import { create as createStore } from 'zustand';

import type { Transport } from '../../../infrastructure/api/transport';
import { byAttemptAge, replacementAllowed } from './derive.ts';
import { evaluateEligibility } from './eligibility.ts';
import {
  freezeRequest,
  thawRequest,
  UNUSABLE_PAYLOAD_MESSAGE,
  type AttemptInput,
} from './freeze.ts';
import type { AttemptStore, NewAttempt, OpenOutcome } from './store.ts';
import type {
  AcknowledgedResult,
  AttemptOutcome,
  AttemptRecord,
  ContainerTarget,
} from './types.ts';

/** What the owner needs from the world. Everything platform-shaped, so a test can drive all of it. */
export interface CreationPorts {
  /** Opens, migrates, and reconciles. The sweep runs inside this, before anything can dispatch. */
  openStore(): Promise<OpenOutcome>;
  create(transport: Transport, request: unknown): Promise<ClientResult<CreateResponse>>;
  /** Wall clock. */
  now(): number;
  /** Monotonic milliseconds, immune to the clock being set. */
  monotonic(): number;
  newId(): string;
  /**
   * Seed and invalidate the caches a creation affects, fenced by the activation it was made under.
   * A late completion from a retired connection must change nothing that is on screen.
   */
  applyCreation(response: CreateResponse, activation: number): Promise<void>;
}

/** The connection an attempt is made under, captured when the operation starts. */
export interface CreationSession {
  readonly activation: number;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly transport: Transport;
  /** False when the connection has an unresolved authentication or protocol problem. */
  readonly usable: boolean;
}

export type StoreProblem =
  | { readonly kind: 'unsupported_version'; readonly found: number; readonly supported: number }
  | { readonly kind: 'failed'; readonly message: string };

export type SubmitOutcome =
  /** Nothing was persisted and nothing was sent. The form keeps what was typed. */
  | { readonly kind: 'not_recorded'; readonly problem: string }
  /** Persisted and dispatched. The attempt is now the owner's; watch its record for the rest. */
  | { readonly kind: 'dispatched'; readonly attemptId: string };

export type ActionOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly problem: string };

export interface SubmitInput {
  readonly target: ContainerTarget;
  readonly title: string;
  readonly body: string;
  readonly session: CreationSession;
  /**
   * A refused record this attempt replaces, deleted in the same transaction that writes the new one.
   * Only ever a definite non-creating record; an ambiguous one is left alone.
   */
  readonly replaces?: AttemptRecord | undefined;
}

export interface CreationState {
  readonly status: 'idle' | 'opening' | 'ready' | 'unavailable';
  /** Why the store is unavailable. Never a reason to fall back to memory. */
  readonly problem: StoreProblem | null;
  readonly records: readonly AttemptRecord[];
  /** Rows that could not be read. Shown as a caveat, never silently dropped. */
  readonly unreadable: number;
  /** Attempts this process is sending right now. */
  readonly sending: readonly string[];
  /**
   * Server successes whose local acknowledgement could not be written.
   *
   * Known creations, held in memory until the write succeeds. The creation is not reported as
   * failed - it demonstrably was not - and what is offered is a retry of the local write, never
   * another creation to repair local storage.
   */
  readonly unsaved: Readonly<Record<string, AcknowledgedResult>>;
  initialize(): Promise<void>;
  retryOpen(): Promise<void>;
  submit(input: SubmitInput): Promise<SubmitOutcome>;
  retry(attemptId: string, session: CreationSession): Promise<ActionOutcome>;
  /**
   * The UI has shown a success, so the record has done its job.
   *
   * Only ever removes a row whose acknowledgement was actually written. A success still held in
   * memory because the local write failed is not acknowledged, so this leaves it alone and its
   * warning stands - which is the whole point of the distinction.
   */
  consume(attemptId: string): Promise<void>;
  saveAcknowledgement(attemptId: string): Promise<ActionOutcome>;
  discard(attemptId: string): Promise<ActionOutcome>;
}

const NOT_RECORDED_PROBLEM =
  'Raphael could not save a record of this attempt on this phone, so it was not sent. Save again to try.';
const NO_STORE_PROBLEM =
  'Raphael cannot save attempts on this phone right now, so nothing was sent.';
const ALREADY_SENDING_PROBLEM = 'This attempt is already being sent.';
const WRONG_CONNECTION_PROBLEM =
  'This attempt belongs to a different server. Connect to it to send it again.';
const DISCARD_FAILED_PROBLEM = 'Raphael could not remove this record. It is still on this phone.';
const UNUSABLE_CONNECTION_PROBLEM =
  'Your server is not accepting requests right now, so nothing was sent. Fix the connection and save again.';
const NO_IDENTIFIER_PROBLEM =
  'Raphael could not generate an identifier for this attempt on this phone, so nothing was sent.';

const outcomeOf = (failure: ClientFailure, at: number): AttemptOutcome => ({
  kind:
    failure.mutationOutcome === 'unknown'
      ? 'unknown'
      : failure.mutationOutcome === 'rejected'
        ? 'rejected'
        : 'not_dispatched',
  // Only a well-formed Raphael envelope carries a code, and only its code is kept - never the
  // envelope, never an exception, never a decoder's own words.
  code: failure.kind === 'api_error' ? failure.error.code : null,
  message: failure.message,
  at,
});

export const createCreationOwner = (ports: CreationPorts) =>
  createStore<CreationState>((set, get) => {
    let store: AttemptStore | null = null;
    /** Enforced here, not by a disabled control: one dispatcher per durable attempt, ever. */
    const inFlight = new Set<string>();
    /** Monotonic marks for attempts this process dispatched. Absent for recovered ones. */
    const dispatchedAt = new Map<string, number>();

    const publishSending = () => {
      set({ sending: [...inFlight] });
    };

    /**
     * Publish one record the store has just written.
     *
     * This, not `refresh`, is how a transition becomes visible. Writing and then rereading the whole
     * table to discover what had been written meant a failed read could leave the app holding the
     * row as it was *before* a success already committed - the creation would present as unresolved
     * and the sheet would offer to make it again under a new key. A fact the owner has persisted is
     * published from the write that persisted it.
     *
     * Null means the row is gone, so it leaves rather than lingering.
     */
    const publish = (attemptId: string, written: AttemptRecord | null): void => {
      set((state) => {
        const without = state.records.filter((record) => record.attemptId !== attemptId);

        if (written === null) return { records: without };

        return { records: [...without, written].sort(byAttemptAge) };
      });
    };

    /**
     * Reconcile against the whole table.
     *
     * Kept for what it is good for - picking up anything this process did not do itself - and
     * deliberately tolerant of failure, because the records on screen were true when they were read
     * and dropping them would lose the person's only route back. Nothing depends on it succeeding.
     */
    const refresh = async (): Promise<void> => {
      if (store === null) return;

      try {
        const { records, unreadable } = await store.list();
        set({ records, unreadable });
      } catch {
        // Deliberately swallowed. See above: this is reconciliation, not publication.
      }
    };

    const elapsedFor = (attemptId: string): number | null => {
      const mark = dispatchedAt.get(attemptId);

      return mark === undefined ? null : ports.monotonic() - mark;
    };

    /**
     * Send one attempt, whatever brought us here.
     *
     * Shared by the first dispatch and every retry, because "what happens to the answer" must not
     * depend on which button was pressed. The frozen request is validated on the way out and the
     * record is kept if it does not survive: a payload this build would change is refused, never
     * rewritten.
     */
    const dispatch = async (record: AttemptRecord, session: CreationSession): Promise<void> => {
      const active = store;
      if (active === null) return;

      const thawed = thawRequest(record.request);

      if (!thawed.ok) {
        publish(
          record.attemptId,
          await active.markBlocked(
            record.attemptId,
            {
              kind: 'unusable_payload',
              code: null,
              message: UNUSABLE_PAYLOAD_MESSAGE,
              at: ports.now(),
            },
            ports.now(),
          ),
        );

        return;
      }

      inFlight.add(record.attemptId);
      dispatchedAt.set(record.attemptId, ports.monotonic());
      publishSending();

      // Held until after the outcome is recorded and published. Seeding and invalidating a cache is
      // a consequence of the creation, not part of establishing it, and awaiting a hierarchy read
      // before publishing the success would leave the sheet saying "Saving…" over a result that is
      // already durable on the server and on this phone.
      let created: CreateResponse | null = null;

      try {
        const result = await ports.create(session.transport, thawed.request);

        if (result.ok) {
          created = result.value;
          const entity = result.value.entity;
          const acknowledged: AcknowledgedResult = {
            // The attempt's own container type, not the response's node type. Every attempt in this
            // subsystem is a container creation, and the server echoes the type it was given, so these
            // agree - but only one of them is guaranteed by construction to be a container, and the
            // local record of a container attempt should not be able to come back saying otherwise.
            type: record.type,
            id: entity.id,
            title: entity.title,
          };

          try {
            publish(
              record.attemptId,
              await active.markAcknowledged(record.attemptId, acknowledged, ports.now()),
            );
          } catch {
            // The server created it. Only the local note of that failed, so the creation is
            // reported as the success it is, with the result held here until the write lands.
            set((state) => ({
              unsaved: { ...state.unsaved, [record.attemptId]: acknowledged },
            }));
          }
        } else {
          const at = ports.now();

          publish(
            record.attemptId,
            result.failure.mutationOutcome === 'unknown'
              ? await active.markUncertain(record.attemptId, at)
              : await active.markBlocked(record.attemptId, outcomeOf(result.failure, at), at),
          );
        }
      } catch {
        // The dispatcher itself came apart after the request left. Nothing is known about what the
        // server did, which is exactly what uncertain means.
        try {
          publish(record.attemptId, await active.markUncertain(record.attemptId, ports.now()));
        } catch {
          // Recorded on the next open by the sweep, which is what it is for.
        }
      } finally {
        inFlight.delete(record.attemptId);
        publishSending();
        // Reconciliation only. Every transition above has already published itself, so a failure
        // here cannot hide one.
        await refresh();
      }

      if (created !== null) {
        // Fenced inside the port: a completion from a retired connection changes no cache. A read
        // that fails here is a failed refresh, never a failed save.
        await ports.applyCreation(created, session.activation);
      }
    };

    const open = async (): Promise<void> => {
      set({ status: 'opening', problem: null });

      let outcome: OpenOutcome;

      try {
        outcome = await ports.openStore();
      } catch (cause) {
        set({
          status: 'unavailable',
          problem: {
            kind: 'failed',
            message: cause instanceof Error ? cause.message : 'the database could not be opened',
          },
        });

        return;
      }

      if (outcome.kind !== 'ready') {
        set({ status: 'unavailable', problem: outcome });

        return;
      }

      store = outcome.store;
      set({ status: 'ready', problem: null });
      await refresh();
    };

    return {
      status: 'idle',
      problem: null,
      records: [],
      unreadable: 0,
      sending: [],
      unsaved: {},

      initialize: async () => {
        if (get().status !== 'idle') return;

        await open();
      },

      retryOpen: open,

      submit: async (input) => {
        const active = store;

        if (active === null) return { kind: 'not_recorded', problem: NO_STORE_PROBLEM };
        // The same condition `retry` enforces, and for the same reason: a connection the app already
        // knows is refusing requests cannot create anything, so dispatching against it only spends an
        // attempt and leaves a record to clean up. The owner holds this, not the Save button - a
        // disabled control is a hint, and this is an invariant.
        if (!input.session.usable) {
          return { kind: 'not_recorded', problem: UNUSABLE_CONNECTION_PROBLEM };
        }

        // Minted before anything is persisted, and inside the guard, because a platform without a
        // usable generator must refuse the save rather than reject out of an async closure nothing
        // is listening to. A weaker identifier is not the fallback: an idempotency key drawn twice
        // would let one key stand for two different requests.
        let attemptId: string;
        let idempotencyKey: string;

        try {
          attemptId = ports.newId();
          idempotencyKey = ports.newId();
        } catch {
          return { kind: 'not_recorded', problem: NO_IDENTIFIER_PROBLEM };
        }

        const frozen = freezeRequest({
          target: input.target,
          title: input.title,
          body: input.body,
          idempotencyKey,
        } satisfies AttemptInput);

        if (!frozen.ok) return { kind: 'not_recorded', problem: frozen.problem };

        const at = ports.now();
        const attempt: NewAttempt = {
          attemptId,
          connectionId: input.session.connectionId,
          endpoint: input.session.endpoint,
          request: frozen.request,
          type: input.target.type,
          title: frozen.title,
          parentAreaId: input.target.parentAreaId,
          at,
        };

        let written: AttemptRecord | null;

        try {
          // Replacement is only ever of a record known to have created nothing. An ambiguous one is
          // the evidence that something may exist, and saving a correction must never delete it.
          if (input.replaces !== undefined && replacementAllowed(input.replaces)) {
            written = await active.replace(input.replaces.attemptId, attempt);
            // The replaced row is gone from the table, so it goes from the projection too.
            publish(input.replaces.attemptId, null);
          } else {
            written = await active.insertIntent(attempt);
          }
        } catch {
          return { kind: 'not_recorded', problem: NOT_RECORDED_PROBLEM };
        }

        if (written === null) return { kind: 'not_recorded', problem: NOT_RECORDED_PROBLEM };

        // The row as the database holds it, read back inside the write's own transaction. Nothing
        // here depends on a separate read succeeding: a failed one afterwards cannot unsay a write,
        // and reporting "not saved" for a row that is on disk would be the one wrong answer
        // available at this point.
        publish(attemptId, written);
        void dispatch(written, input.session);

        return { kind: 'dispatched', attemptId };
      },

      retry: async (attemptId, session) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        if (inFlight.has(attemptId)) return { kind: 'refused', problem: ALREADY_SENDING_PROBLEM };

        const record = get().records.find((candidate) => candidate.attemptId === attemptId);

        if (record === undefined) return { kind: 'refused', problem: 'That attempt is gone.' };
        if (record.state === 'acknowledged') {
          return { kind: 'refused', problem: 'That was already created.' };
        }
        if (record.connectionId !== session.connectionId || !session.usable) {
          return { kind: 'refused', problem: WRONG_CONNECTION_PROBLEM };
        }

        // Checked here, immediately before the send, rather than when a sheet opened. A window that
        // was eligible two hours ago is not a fact about now.
        const eligibility = evaluateEligibility({
          now: ports.now(),
          firstDispatchAt: record.firstDispatchAt,
          lastObservedAt: record.observedAt,
          clockAnomaly: record.clockAnomaly,
          monotonicElapsedMs: elapsedFor(attemptId),
        });

        if (eligibility.kind !== 'eligible') {
          if (eligibility.kind === 'clock_anomaly' && !record.clockAnomaly) {
            // Recorded so it stays true. An anomaly that vanished when the clock caught up would be
            // a guarantee drawn from the measurement that had just been wrong.
            try {
              publish(attemptId, await active.markClockAnomaly(attemptId, ports.now()));
            } catch {
              // The refusal stands either way; only its persistence failed.
            }
          }

          return { kind: 'refused', problem: 'This attempt can no longer be sent again.' };
        }

        await dispatch(record, session);

        return { kind: 'done' };
      },

      consume: async (attemptId) => {
        const active = store;
        const record = get().records.find((candidate) => candidate.attemptId === attemptId);

        if (active === null || record?.state !== 'acknowledged') return;

        try {
          await active.remove(attemptId);
        } catch {
          // Cleanup that fails leaves a recoverable acknowledged row, which is the safe direction:
          // it can be dismissed by hand and it is never resent. A refresh is not what decides this.
          return;
        }

        dispatchedAt.delete(attemptId);
        publish(attemptId, null);
      },

      saveAcknowledgement: async (attemptId) => {
        const active = store;
        const result = get().unsaved[attemptId];

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        if (result === undefined) return { kind: 'done' };

        try {
          publish(attemptId, await active.markAcknowledged(attemptId, result, ports.now()));
        } catch {
          return {
            kind: 'refused',
            problem: 'Raphael still could not save this result on this phone.',
          };
        }

        set((state) => {
          const { [attemptId]: _saved, ...rest } = state.unsaved;

          return { unsaved: rest };
        });

        return { kind: 'done' };
      },

      /**
       * Remove a local record. Consuming a success and abandoning an ambiguous attempt are the same
       * operation here, and differ entirely in what the caller says first: one is a dismissal of
       * something known to exist, the other needs a warning that it cannot undo a server creation.
       */
      discard: async (attemptId) => {
        const active = store;

        if (active === null) return { kind: 'refused', problem: NO_STORE_PROBLEM };
        if (inFlight.has(attemptId)) return { kind: 'refused', problem: ALREADY_SENDING_PROBLEM };

        try {
          await active.remove(attemptId);
        } catch {
          return { kind: 'refused', problem: DISCARD_FAILED_PROBLEM };
        }

        set((state) => {
          const { [attemptId]: _removed, ...rest } = state.unsaved;

          return { unsaved: rest };
        });
        dispatchedAt.delete(attemptId);
        publish(attemptId, null);

        return { kind: 'done' };
      },
    };
  });

export type CreationOwner = ReturnType<typeof createCreationOwner>;
