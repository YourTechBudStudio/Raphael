/**
 * The wiring between the reducer and the world: promises, timers, and the one script channel.
 *
 * This deliberately does not live in the component. Everything here is a way a barrier could hang
 * forever, resolve twice, or outlive the route that opened it, and none of that is testable through
 * a React tree. The component above is left with prop forwarding and a `key`.
 *
 * It owns no persistence and dispatches no request. A captured snapshot means the editor handed a
 * document over; what that is worth is the owner's decision.
 */

import type { EditorCommand, EditorSelectionState } from '../bridge.ts';
import type { EditorStamp } from '../bridge.ts';
import { encodeHostMessage, hostMessageFits } from './protocol.ts';
import {
  createSession,
  reduce,
  type BarrierResult,
  type EditorProblem,
  type EditorSnapshot,
  type SessionEffect,
  type SessionEvent,
  type SessionState,
} from './session.ts';

/** What capture injects and drives. The controller satisfies it; nothing else needs the component. */
export interface EditorPort {
  /**
   * Ask the editor for its current document.
   *
   * `lock` stops the host sending and asks the browser to settle composition first, so nothing can
   * change under the barrier. The result says what the editor did, never what was stored.
   */
  readonly requestSnapshot: (options?: { readonly lock?: boolean }) => Promise<BarrierResult>;
  /** Release or re-take the lock. A permanently read-only host refuses to become editable. */
  readonly setEditable: (editable: boolean) => void;
  readonly send: (command: EditorCommand) => void;
}

export interface EditorCallbacks {
  readonly onSnapshot?: ((snapshot: EditorSnapshot) => void) | undefined;
  readonly onSelectionChange?: ((state: EditorSelectionState) => void) | undefined;
  readonly onLockedChange?: ((locked: boolean) => void) | undefined;
  readonly onProblem?: ((problem: EditorProblem) => void) | undefined;
  /**
   * A link was tapped. The href has already passed `@raphael/content`'s shared URL policy — the same
   * one strict validation uses — so it is http, https or mailto, parses, carries no credentials and
   * is within bounds. That is "permitted", not "trusted destination": deciding whether to open it is
   * the consumer's. The editor itself never navigates, with or without this callback.
   */
  readonly onLinkPress?: ((href: string) => void) | undefined;
}

export interface ControllerBindings {
  /** Deliver one script to the live renderer. */
  readonly inject: (script: string) => void;
  /** Replace the renderer; the new session's `ready` restarts the handshake. */
  readonly restartRenderer: (sessionId: number) => void;
  /** Callbacks are read fresh per effect so a re-rendering parent cannot strand a stale one. */
  readonly callbacks: () => EditorCallbacks;
  readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface EditorController extends EditorPort {
  /** One raw payload from the renderer. */
  readonly receive: (raw: unknown) => void;
  readonly replaceDocument: (documentId: string, document: unknown) => void;
  readonly setUnprotected: (unprotected: boolean) => void;
  readonly rendererTerminated: () => void;
  /** Settles everything outstanding and clears every timer. Nothing may outlive the mount. */
  readonly dispose: () => void;
  /** Diagnostics and tests only; not a contract anything drives behaviour from. */
  readonly state: () => SessionState;
}

export const createEditorController = (
  input: {
    readonly stamp: EditorStamp;
    readonly documentId: string;
    readonly document: unknown;
    readonly editable: boolean;
    readonly unprotected?: boolean | undefined;
    readonly snapshotTimeoutMs: number;
  },
  bindings: ControllerBindings,
): EditorController => {
  const setTimer = bindings.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    bindings.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state = createSession({
    stamp: input.stamp,
    documentId: input.documentId,
    document: input.document,
    editable: input.editable,
    ...(input.unprotected === undefined ? {} : { unprotected: input.unprotected }),
  });
  const waiters = new Map<number, (result: BarrierResult) => void>();
  const timers = new Map<number, unknown>();
  /** Holds the resolver of the call being reduced right now, until its effect claims it. */
  let opening: ((result: BarrierResult) => void) | null = null;
  let disposed = false;

  const settle = (requestId: number, result: BarrierResult): void => {
    const timer = timers.get(requestId);
    if (timer !== undefined) {
      clearTimer(timer);
      timers.delete(requestId);
    }
    const waiter = waiters.get(requestId);
    // Deleted before it is called, so a waiter can never be settled twice however it is reached.
    waiters.delete(requestId);
    waiter?.(result);
  };

  const perform = (effect: SessionEffect): void => {
    const callbacks = bindings.callbacks();
    switch (effect.kind) {
      case 'send': {
        if (!hostMessageFits(effect.message)) {
          callbacks.onProblem?.({
            stage: 'envelope',
            refusal: 'too_large',
            sessionId: state.sessionId,
          });
          return;
        }
        bindings.inject(encodeHostMessage(effect.message));
        return;
      }
      case 'snapshot':
        callbacks.onSnapshot?.(effect.snapshot);
        return;
      case 'selection':
        callbacks.onSelectionChange?.(effect.state);
        return;
      case 'barrierOpened': {
        const resolve = opening;
        opening = null;
        if (resolve !== null) waiters.set(effect.requestId, resolve);
        // The host's timeout is the authoritative end of a barrier. No margin on the other side is a
        // promise that a reply arrives first, so this must be able to end it alone.
        timers.set(
          effect.requestId,
          setTimer(() => {
            timers.delete(effect.requestId);
            run({ type: 'barrierTimedOut', requestId: effect.requestId });
          }, input.snapshotTimeoutMs),
        );
        return;
      }
      case 'barrierRefused': {
        const resolve = opening;
        opening = null;
        resolve?.(effect.result);
        return;
      }
      case 'settle':
        settle(effect.requestId, effect.result);
        return;
      case 'problem':
        callbacks.onProblem?.(effect.problem);
        return;
      case 'locked':
        callbacks.onLockedChange?.(effect.locked);
        return;
      case 'link':
        callbacks.onLinkPress?.(effect.href);
        return;
      case 'restartRenderer':
        bindings.restartRenderer(state.sessionId);
        return;
    }
  };

  const run = (event: SessionEvent): void => {
    if (disposed) return;
    const reduction = reduce(state, event);
    state = reduction.state;
    for (const effect of reduction.effects) perform(effect);
  };

  return {
    receive: (raw) => {
      run({ type: 'message', raw });
    },
    replaceDocument: (documentId, document) => {
      run({ type: 'documentReplaced', documentId, document });
    },
    setUnprotected: (unprotected) => {
      run({ type: 'unprotectedChanged', unprotected });
    },
    rendererTerminated: () => {
      run({ type: 'rendererTerminated' });
    },
    requestSnapshot: (options) =>
      new Promise<BarrierResult>((resolve) => {
        if (disposed) {
          resolve({ kind: 'unanswered' });
          return;
        }
        opening = resolve;
        run({ type: 'barrierRequested', lock: options?.lock ?? false });
        // Nothing claimed it, which can only mean the reducer produced neither effect. Resolving
        // here is what stops a caller awaiting a barrier that was never opened.
        if (opening !== null) {
          opening = null;
          resolve({ kind: 'unanswered' });
        }
      }),
    setEditable: (editable) => {
      run({ type: 'editableRequested', editable });
    },
    send: (command) => {
      run({ type: 'commandRequested', command });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      // Every waiter settles: a route that has gone must not leave a promise no one will ever
      // resolve, and nothing is known about writing since the last accepted snapshot.
      const outstanding = [...waiters.values()];
      waiters.clear();
      for (const waiter of outstanding) waiter({ kind: 'unanswered' });
    },
    state: () => state,
  };
};
