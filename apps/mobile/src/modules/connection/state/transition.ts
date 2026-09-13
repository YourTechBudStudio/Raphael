import type { Transport } from '@raphael/client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

import type { ConnectionRecord, RecordProblem } from './record.ts';
import type { ConnectionStorage } from './storage.ts';

/**
 * Which server this device talks to, who is allowed to change that, and what happens when it does.
 *
 * This is one owner for the whole transition, rather than a flag each screen consults. The reason
 * is that the dangerous states are all *between* two connections: a verification that finishes
 * after the person chose a different server, a startup read that completes after a disconnect, a
 * 401 from the connection before last arriving now, a write that lands after a newer decision.
 * Every one of those is a completion racing a decision, and guards spread across the screens that
 * happen to observe them will always miss the one nobody thought about.
 *
 * So there are exactly two identities, and they do different jobs.
 *
 * `connectionId` is stable and names **the server at an address**. It survives a key rotation
 * against the same address, which is what lets session-only content stay attached across one, and
 * it is what a durable pending attempt will be filed under in phase 09. It is a local name, never
 * a guarantee about server identity: swapping the database behind an unchanged address produces a
 * different server this device has no way to notice, which is an operational limitation and is
 * documented as one.
 *
 * `activation` names **the current work**. It changes on every switch, including a rotation,
 * because the requests in flight at that moment were made with the old credential. It stamps every
 * query key, and every completion that is not a query is checked against it before it is allowed
 * to change anything.
 *
 * The credential is never in this store's public shape. It is captured inside the transport's
 * closure when a session is built, and the only way to use it is to make a request.
 *
 * Every platform dependency arrives through `ConnectionPorts`, so the whole of this - a read that
 * resolves after a disconnect, a write that refuses, a delete that fails, a rotation, a switch -
 * runs under `node --test` with no device and no server.
 */

export type StorageState =
  /** Written to this device's secure storage. It will be here next launch. */
  | { readonly kind: 'saved' }
  /** Secure storage exists and refused the write. This connection lasts for the session. */
  | { readonly kind: 'write_failed'; readonly message: string }
  /** This platform has no secure storage. Nothing was attempted. */
  | { readonly kind: 'unsupported' };

/** What a screen may know about the connection. Never the key. */
export interface Connection {
  readonly connectionId: string;
  /** Origin plus any base path, no trailing slash. */
  readonly base: string;
  /** For display. */
  readonly origin: string;
  /**
   * The protocol version established when this connection was verified.
   *
   * Historical, and read as such. It is what one exchange proved at one moment, not a promise that
   * the server on the other end still speaks it now.
   */
  readonly protocolVersion: number;
  /** When that verification happened. */
  readonly verifiedAt: string;
  readonly storage: StorageState;
}

export interface ConnectionSession {
  readonly activation: number;
  readonly connection: Connection;
  /** Carries the credential privately. Captured by query functions so a switch cannot retarget one. */
  readonly transport: Transport;
}

/**
 * Why the current connection is unusable, when it is the connection rather than one request that is
 * the problem.
 *
 * Recorded, never acted on automatically. Neither of these deletes the stored credential: a server
 * that refuses a key today may be one that was restarted with the wrong one, and discarding the key
 * would take away the thing the owner would have corrected.
 */
export type Rejection = 'unauthorized' | 'incompatible_protocol';

export type ConnectionPhase =
  /** Reading storage. Distinct from having read it and found nothing. */
  | { readonly kind: 'loading' }
  /**
   * Storage was read and holds no connection.
   *
   * `removalProblem` is set when a disconnect could not delete the stored record. The credential is
   * no longer in use but may still be on the device and may be read again on the next launch, which
   * is a different thing from having forgotten it and has to be said somewhere the person will see
   * it. It lives on the phase rather than in a screen's own state because disconnecting unmounts
   * the screen that asked: the gate swaps to setup the moment the phase changes, so a warning held
   * in Settings could never render.
   */
  | { readonly kind: 'absent'; readonly removalProblem: string | null }
  /** Something is stored and cannot be used. Not the same as nothing being stored. */
  | {
      readonly kind: 'unreadable';
      readonly problem: RecordProblem | 'failed';
      readonly message: string;
    }
  | {
      readonly kind: 'active';
      readonly session: ConnectionSession;
      readonly rejection: Rejection | null;
    };

/** What `establish` did, for the screen that asked for it. */
export type EstablishOutcome =
  | { readonly kind: 'activated' }
  /** A replacement could not be stored, so the existing connection was kept, untouched. */
  | { readonly kind: 'replace_not_saved'; readonly message: string }
  /** A newer decision overtook this one. Nothing was written and nothing was switched. */
  | { readonly kind: 'superseded' }
  /** A verified address and key could not build a transport. Should not happen; reported anyway. */
  | { readonly kind: 'unusable'; readonly message: string };

export type DisconnectOutcome =
  | { readonly kind: 'removed' }
  /** The active connection is gone; the stored one may still be there next launch. */
  | { readonly kind: 'still_stored'; readonly message: string }
  /** A newer decision took over before this one finished. It owns the outcome now. */
  | { readonly kind: 'superseded' };

export interface EstablishInput {
  readonly base: string;
  readonly origin: string;
  readonly apiKey: string;
  readonly protocolVersion: number;
}

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  readonly hydrate: () => Promise<void>;
  readonly establish: (input: EstablishInput) => Promise<EstablishOutcome>;
  readonly disconnect: () => Promise<DisconnectOutcome>;
  /** Tries the deletion again after it failed. Does nothing if a connection has since been made. */
  readonly retryRemoval: () => Promise<DisconnectOutcome>;
  /** Records a connection-level refusal, if it belongs to the connection that is current. */
  readonly noteRejection: (activation: number, rejection: Rejection) => void;
  readonly clearRejection: () => void;
}

export interface ConnectionPorts {
  readonly storage: ConnectionStorage;
  readonly createTransport: (
    base: string,
    apiKey: string,
  ) =>
    | { readonly ok: true; readonly transport: Transport }
    | { readonly ok: false; readonly message: string };
  /** Cancels work in flight and drops everything the previous connection had cached. */
  readonly retireCaches: () => void;
  /** Drops session-only content. Called on an explicit disconnect and nowhere else. */
  readonly forgetLocalContent: (connectionId: string) => void;
  readonly newConnectionId: () => string;
  readonly now: () => string;
}

export type ConnectionStore = UseBoundStore<StoreApi<ConnectionState>>;

export const createConnectionStore = (ports: ConnectionPorts): ConnectionStore => {
  /**
   * Outside the store's state so a completion can be fenced against it without reading a snapshot
   * that may already be stale by the time the check runs.
   */
  let activation = 0;
  /**
   * Which connection decision is in charge.
   *
   * Distinct from `activation`, and it has to be. `activation` counts connections that actually
   * became live; this counts *intentions*, and it advances the moment someone decides, before any
   * storage has been touched. That gap is where the bug was: the storage queue can drop a mutation
   * that has not started, but once a write is inside the keychain it will finish, and the caller
   * waiting on it would go on to activate a connection the person had already disconnected from -
   * leaving the app live against a server whose record had just been deleted underneath it.
   *
   * So every decision takes a ticket, and every `await` inside one is followed by a check that the
   * ticket is still current. A decision that has been overtaken stops without touching the phase.
   */
  let decision = 0;
  /** Hydration runs once. A second call joins the first rather than racing it. */
  let hydrating: Promise<void> | null = null;

  const store = create<ConnectionState>((set, get) => {
    const activeSession = (): ConnectionSession | null => {
      const { phase } = get();

      return phase.kind === 'active' ? phase.session : null;
    };

    /**
     * Switches to a record, unmaking whatever the previous connection left behind.
     *
     * Cancelling stops in-flight work from finishing at all; clearing removes what was already
     * cached. The activation stamp on every query key means neither is strictly required for
     * correctness - a stale result lands under a key nothing reads - but leaving another server's
     * entities in memory until a collector gets to them is not a thing to do with someone's data.
     */
    const activate = (record: ConnectionRecord, storage: StorageState): EstablishOutcome => {
      const built = ports.createTransport(record.base, record.apiKey);

      if (!built.ok) return { kind: 'unusable', message: built.message };

      ports.retireCaches();
      activation += 1;

      set({
        phase: {
          kind: 'active',
          rejection: null,
          session: {
            activation,
            transport: built.transport,
            connection: {
              connectionId: record.connectionId,
              base: record.base,
              origin: record.origin,
              protocolVersion: record.protocolVersion,
              verifiedAt: record.verifiedAt,
              storage,
            },
          },
        },
      });

      return { kind: 'activated' };
    };

    /**
     * What to say once a deletion has been attempted.
     *
     * A failed delete is recorded on the phase, not returned and forgotten: the screen that asked
     * for it is already gone by the time the answer arrives. "Superseded" needs no report at all -
     * someone has connected since, and the stored record is that connection's business now.
     */
    const finishRemoval = (
      removed: { readonly kind: string; readonly message?: string },
      mine: number,
    ): DisconnectOutcome => {
      if (mine !== decision) return { kind: 'superseded' };

      const { phase } = get();

      if (removed.kind === 'failed') {
        const message = removed.message ?? '';

        if (phase.kind === 'absent') set({ phase: { kind: 'absent', removalProblem: message } });

        return { kind: 'still_stored', message };
      }

      if (phase.kind === 'absent' && phase.removalProblem !== null) {
        set({ phase: { kind: 'absent', removalProblem: null } });
      }

      return { kind: 'removed' };
    };

    return {
      phase: { kind: 'loading' },

      hydrate: () => {
        hydrating ??= (async () => {
          const outcome = await ports.storage.read();

          // A read that lands after someone has already connected or disconnected is answering a
          // question nobody is asking any more, and must not reactivate anything.
          if (get().phase.kind !== 'loading') return;

          switch (outcome.kind) {
            case 'loaded': {
              const activated = activate(outcome.record, { kind: 'saved' });

              // A record can be well-formed and still name an address this build's transport will
              // not accept. Ignoring that left the app on the loading spinner for ever, with
              // nothing said and nothing to press. It is a stored connection that cannot be used,
              // which is exactly what the unreadable state is for.
              if (activated.kind === 'unusable') {
                set({
                  phase: {
                    kind: 'unreadable',
                    problem: 'unreadable',
                    message: `The saved connection names an address Raphael cannot use. ${activated.message}`,
                  },
                });
              }

              return;
            }
            case 'absent':
            case 'unsupported':
              set({ phase: { kind: 'absent', removalProblem: null } });

              return;
            case 'invalid':
              set({
                phase: {
                  kind: 'unreadable',
                  problem: outcome.problem,
                  message:
                    outcome.problem === 'unsupported_version'
                      ? 'The saved connection was written by a newer version of Raphael.'
                      : 'The saved connection could not be read.',
                },
              });

              return;
            case 'failed':
              set({ phase: { kind: 'unreadable', problem: 'failed', message: outcome.message } });
          }
        })();

        return hydrating;
      },

      establish: async (input) => {
        const mine = ++decision;
        const previous = activeSession();
        // The same address keeps its identity, so rotating a key does not orphan what was captured
        // under it. A different address is a different server as far as this device is concerned.
        const connectionId =
          previous !== null && previous.connection.base === input.base
            ? previous.connection.connectionId
            : ports.newConnectionId();

        const record: ConnectionRecord = {
          version: 1,
          connectionId,
          base: input.base,
          origin: input.origin,
          apiKey: input.apiKey,
          protocolVersion: input.protocolVersion,
          verifiedAt: ports.now(),
        };

        const written = await ports.storage.save(record);

        // The write may have been dropped before it ran, or it may have run to completion while
        // someone disconnected. Both mean this decision is no longer the one in charge, and neither
        // may activate anything: the first because nothing was stored, the second because what was
        // stored is being deleted by the decision that replaced this one.
        if (written.kind === 'superseded' || mine !== decision) return { kind: 'superseded' };

        if (written.kind === 'failed') {
          // Replacing is the case where a failed write must change nothing. Someone already has a
          // working connection, and swapping it for one this device forgets on the next launch -
          // losing the one it can still reach - leaves them worse off than before they asked.
          if (previous !== null) return { kind: 'replace_not_saved', message: written.message };

          // A first connection is different. There is nothing to lose by connecting, and refusing
          // over a keychain that said no would leave the app unusable for something the person can
          // work around by staying in it. It connects, and says plainly that it will ask again.
          return activate(record, { kind: 'write_failed', message: written.message });
        }

        if (written.kind === 'unsupported') return activate(record, { kind: 'unsupported' });

        return activate(record, { kind: 'saved' });
      },

      disconnect: async () => {
        const mine = ++decision;
        const previous = activeSession();

        ports.retireCaches();
        activation += 1;
        set({ phase: { kind: 'absent', removalProblem: null } });

        // The one place session-only content is deliberately dropped. Switching servers does not
        // drop it: the connection id is what it belongs to, and coming back to the same address
        // comes back to the same id.
        if (previous !== null) ports.forgetLocalContent(previous.connection.connectionId);

        return finishRemoval(await ports.storage.remove(), mine);
      },

      retryRemoval: async () => {
        const mine = ++decision;

        return finishRemoval(await ports.storage.remove(), mine);
      },

      noteRejection: (forActivation, rejection) => {
        const { phase } = get();

        // A refusal from a connection that is no longer current says nothing about the current one.
        if (phase.kind !== 'active' || phase.session.activation !== forActivation) return;
        if (phase.rejection === rejection) return;

        set({ phase: { ...phase, rejection } });
      },

      clearRejection: () => {
        const { phase } = get();

        if (phase.kind !== 'active' || phase.rejection === null) return;

        set({ phase: { ...phase, rejection: null } });
      },
    };
  });

  return store;
};
