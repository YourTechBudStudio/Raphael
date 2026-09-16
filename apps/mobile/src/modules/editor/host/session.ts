/**
 * The host's session and sequencing rules, as a pure reducer.
 *
 * Being pure is the point: every race this capability has to survive — a retired session's snapshot,
 * an out-of-order sequence, a barrier that is refused rather than answered, a renderer that dies
 * holding writing native never received — is reachable from `node --test` without a device, and the
 * component below it stays a thin adapter that performs effects.
 *
 * What this module does *not* do: persist anything, dispatch anything, or decide what a draft
 * version is. A captured snapshot means the editor handed over a document, never that the writing is
 * durably stored. Capture owns that, and owns the counter that says so.
 */

import type { ContentFailure } from '@raphael/content';
import { isAllowedHref } from '@raphael/content/validation';

import type {
  EditorCommand,
  EditorRejectionCode,
  EditorSelectionState,
  EditorStamp,
  HostMessage,
} from '../bridge.ts';
import { inspectSnapshotDocument, receiveEnvelope, type EnvelopeRefusal } from './protocol.ts';

/** A document the host has accepted from the WebView, with the session and sequence that produced it. */
export interface EditorSnapshot {
  readonly sessionId: number;
  readonly editSeq: number;
  readonly document: unknown;
}

/**
 * How a snapshot barrier ended.
 *
 * `captured` means exactly that the editor handed over a document the host accepted — not that
 * anything was written down. `unchanged` is relative to this session's last accepted snapshot, so a
 * caller can tell a confirmation from an authored change.
 */
export type BarrierResult =
  | { readonly kind: 'captured'; readonly snapshot: EditorSnapshot; readonly unchanged: boolean }
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'refused'; readonly code: EditorRejectionCode };

/**
 * Something the surface may need to say. Every variant is bounded vocabulary plus structural
 * location: no authored content, no raw message body, no decoder string.
 */
export type EditorProblem =
  | { readonly stage: 'envelope'; readonly refusal: EnvelopeRefusal; readonly sessionId: number }
  | {
      readonly stage: 'handshake';
      readonly expected: EditorStamp;
      readonly received: EditorStamp;
    }
  | { readonly stage: 'document'; readonly failure: ContentFailure; readonly sessionId: number }
  | { readonly stage: 'editor'; readonly code: EditorRejectionCode; readonly sessionId: number }
  /**
   * A link was tapped that the shared URL policy does not permit. The href is deliberately absent:
   * a refused link is untrusted input, and a diagnostic that reflects it is a leak with a
   * reassuring name.
   */
  | { readonly stage: 'link'; readonly sessionId: number }
  | {
      readonly stage: 'recovery';
      readonly sessionId: number;
      /** The renderer died holding a document it had refused to hand over. Those bytes are gone. */
      readonly lostRendererWriting: boolean;
    };

export type SessionPhase = 'loading' | 'handshaking' | 'initialized' | 'editing' | 'incompatible';

interface Barrier {
  readonly requestId: number;
  readonly lock: boolean;
  /**
   * This barrier is what took the host's lock, so this barrier is what has to give it back.
   *
   * False when the caller was already locked for its own reasons, or when the host is permanently
   * read-only and there was never a lock to take.
   */
  readonly tookLock: boolean;
}

export interface SessionState {
  readonly phase: SessionPhase;
  readonly sessionId: number;
  /** Identity of the document under edit. A change is a legitimate replacement; equality is not. */
  readonly documentId: string;
  /** False means a permanently read-only host: no lock release can make it editable. */
  readonly editable: boolean;
  /** The host has stopped sending commands. Set when a lock is asked for, not when it is confirmed. */
  readonly locked: boolean;
  readonly lastAcceptedSeq: number;
  /** The newest document this host holds. Never replaced by older content. */
  readonly latestAccepted: EditorSnapshot | null;
  /** Carried through crash recovery unchanged; the owner decides what it means. */
  readonly unprotected: boolean;
  /** The renderer refused to hand over its live document, so only the renderer has it. */
  readonly rendererOnlyWriting: boolean;
  readonly barrier: Barrier | null;
  readonly nextRequestId: number;
  /** What the next `init` will carry: the newest work held, falling back to the owner's document. */
  readonly pendingDocument: unknown;
  readonly stamp: EditorStamp;
}

export type SessionEvent =
  | { readonly type: 'message'; readonly raw: unknown }
  | { readonly type: 'documentReplaced'; readonly documentId: string; readonly document: unknown }
  | { readonly type: 'unprotectedChanged'; readonly unprotected: boolean }
  | { readonly type: 'rendererTerminated' }
  | { readonly type: 'barrierRequested'; readonly lock: boolean }
  | { readonly type: 'barrierTimedOut'; readonly requestId: number }
  | { readonly type: 'barrierCancelled' }
  | { readonly type: 'editableRequested'; readonly editable: boolean }
  | { readonly type: 'commandRequested'; readonly command: EditorCommand };

export type SessionEffect =
  | { readonly kind: 'send'; readonly message: HostMessage }
  /** An authored change for the owner. Never emitted for a snapshot that settles a barrier. */
  | { readonly kind: 'snapshot'; readonly snapshot: EditorSnapshot }
  | { readonly kind: 'selection'; readonly state: EditorSelectionState }
  | { readonly kind: 'barrierOpened'; readonly requestId: number }
  /** The barrier could not even be opened; the caller's own call resolves with this. */
  | { readonly kind: 'barrierRefused'; readonly result: BarrierResult }
  | { readonly kind: 'settle'; readonly requestId: number; readonly result: BarrierResult }
  | { readonly kind: 'problem'; readonly problem: EditorProblem }
  | { readonly kind: 'locked'; readonly locked: boolean }
  | { readonly kind: 'link'; readonly href: string }
  /** The renderer must be replaced; the component remounts the WebView under the new session. */
  | { readonly kind: 'restartRenderer' };

export interface Reduction {
  readonly state: SessionState;
  readonly effects: readonly SessionEffect[];
}

/** A stamp is our own bundle's, but it arrives over a bridge, so its strings are bounded on arrival. */
const DIGEST_MAX_CHARS = 80;

const boundedStamp = (stamp: EditorStamp): EditorStamp => ({
  bridgeVersion: stamp.bridgeVersion,
  contentSchemaVersion: stamp.contentSchemaVersion,
  payloadDigest: stamp.payloadDigest.slice(0, DIGEST_MAX_CHARS),
});

export const createSession = (input: {
  readonly stamp: EditorStamp;
  readonly documentId: string;
  readonly document: unknown;
  readonly editable: boolean;
  readonly unprotected?: boolean;
}): SessionState => ({
  phase: 'loading',
  sessionId: 1,
  documentId: input.documentId,
  editable: input.editable,
  locked: false,
  lastAcceptedSeq: 0,
  latestAccepted: null,
  unprotected: input.unprotected ?? false,
  rendererOnlyWriting: false,
  barrier: null,
  nextRequestId: 1,
  pendingDocument: input.document,
  stamp: input.stamp,
});

/**
 * End a barrier, and give back the lock unless the barrier earned the right to keep it.
 *
 * Only a captured snapshot holds the lock afterwards: that is the closed interval Save and
 * controlled navigation are built on, and the caller releases it when its own work is done. Every
 * other ending — a timeout, a document the editor could produce but nothing can store, an envelope
 * too large to send, a composition that never settled, a cancelled navigation — has to leave editing
 * live. A person whose note is past the node limit repairs it with undo or by cutting it down, and
 * both of those need an editable editor and an enabled toolbar. Locked, the only offer left would be
 * to discard the writing.
 *
 * `addressable` is false when the renderer this lock was taken on is already gone, so there is
 * nobody to send the release to; the host still drops its own half.
 */
const settleBarrier = (
  state: SessionState,
  result: BarrierResult,
  { addressable = true }: { readonly addressable?: boolean } = {},
): { readonly state: SessionState; readonly effects: readonly SessionEffect[] } => {
  if (state.barrier === null) return { state, effects: [] };

  const releasing = result.kind !== 'captured' && state.barrier.tookLock && state.locked;
  const effects: SessionEffect[] = [];
  if (releasing) {
    effects.push({ kind: 'locked', locked: false });
    if (addressable) {
      // Both halves: the host starts sending again, and the renderer accepts input again. Either one
      // alone leaves the editor looking live and refusing every command, or the reverse.
      effects.push({
        kind: 'send',
        message: { type: 'setEditable', sessionId: state.sessionId, editable: true },
      });
    }
  }
  effects.push({ kind: 'settle', requestId: state.barrier.requestId, result });

  return {
    state: { ...state, barrier: null, ...(releasing ? { locked: false } : {}) },
    effects,
  };
};

/**
 * Start a new identity over the writing this host already holds.
 *
 * The newest accepted snapshot wins over the owner's document, because it is newer. A document the
 * renderer refused to hand over is not here to preserve, and saying so is the whole reason
 * `lostRendererWriting` exists.
 */
const restart = (state: SessionState): Reduction => {
  const settled = settleBarrier(state, { kind: 'unanswered' }, { addressable: false });
  const sessionId = settled.state.sessionId + 1;
  return {
    state: {
      ...settled.state,
      sessionId,
      phase: 'loading',
      locked: false,
      lastAcceptedSeq: 0,
      rendererOnlyWriting: false,
      pendingDocument: settled.state.latestAccepted?.document ?? settled.state.pendingDocument,
    },
    effects: [
      ...settled.effects,
      ...(settled.state.locked ? [{ kind: 'locked', locked: false } as const] : []),
      {
        kind: 'problem',
        problem: {
          stage: 'recovery',
          sessionId,
          lostRendererWriting: state.rendererOnlyWriting,
        },
      },
      { kind: 'restartRenderer' },
    ],
  };
};

const handshake = (state: SessionState, received: EditorStamp): Reduction => {
  const bounded = boundedStamp(received);
  const matches =
    bounded.bridgeVersion === state.stamp.bridgeVersion &&
    bounded.contentSchemaVersion === state.stamp.contentSchemaVersion &&
    bounded.payloadDigest === state.stamp.payloadDigest;

  if (!matches) {
    // The draft is untouched and no document is sent: an independently stale bundle must not be
    // handed writing it may not understand.
    return {
      state: { ...state, phase: 'incompatible' },
      effects: [
        {
          kind: 'problem',
          problem: { stage: 'handshake', expected: state.stamp, received: bounded },
        },
      ],
    };
  }

  return {
    state: { ...state, phase: 'handshaking' },
    effects: [
      {
        kind: 'send',
        message: {
          type: 'init',
          sessionId: state.sessionId,
          document: state.pendingDocument,
          editable: state.editable,
        },
      },
    ],
  };
};

const acceptSnapshot = (
  state: SessionState,
  snapshot: EditorSnapshot,
  correlated: boolean,
): Reduction => {
  const unchanged = snapshot.editSeq === state.lastAcceptedSeq;
  const next: SessionState = {
    ...state,
    phase: 'editing',
    lastAcceptedSeq: Math.max(state.lastAcceptedSeq, snapshot.editSeq),
    latestAccepted: snapshot,
    rendererOnlyWriting: false,
  };

  // Exactly one route to the owner per snapshot: a barrier's answer is its result, not also a
  // callback, or one authored change would look like two.
  if (correlated) {
    const settled = settleBarrier(next, { kind: 'captured', snapshot, unchanged });
    return { state: settled.state, effects: settled.effects };
  }
  return { state: next, effects: [{ kind: 'snapshot', snapshot }] };
};

const onMessage = (state: SessionState, raw: unknown): Reduction => {
  const envelope = receiveEnvelope(raw);
  if (envelope.kind === 'refused') {
    return {
      state,
      effects: [
        {
          kind: 'problem',
          problem: { stage: 'envelope', refusal: envelope.refusal, sessionId: state.sessionId },
        },
      ],
    };
  }

  const message = envelope.message;

  if (message.type === 'ready') {
    const received: EditorStamp = {
      bridgeVersion: message.bridgeVersion,
      contentSchemaVersion: message.contentSchemaVersion,
      payloadDigest: message.payloadDigest,
    };
    if (state.phase === 'loading') return handshake(state, received);
    // A `ready` we did not ask for means the renderer restarted on its own. Treat it as the crash it
    // is, then handshake the new identity, rather than trusting a session we no longer know.
    const restarted = restart(state);
    const handshaked = handshake(restarted.state, received);
    return { state: handshaked.state, effects: [...restarted.effects, ...handshaked.effects] };
  }

  // Everything else is session-scoped. A message from a retired session is the expected consequence
  // of reinitializing, not an error, and is dropped without a word.
  if (message.sessionId !== state.sessionId) return { state, effects: [] };

  switch (message.type) {
    case 'initialized':
      return {
        state: state.phase === 'handshaking' ? { ...state, phase: 'initialized' } : state,
        effects: [],
      };

    case 'selection':
      return { state, effects: [{ kind: 'selection', state: message.state }] };

    case 'link': {
      // A link only means anything once a document is loaded, and only from the current session -
      // both already established above.
      if (!canTalkToEditor(state)) return { state, effects: [] };
      // The shared policy, not a second allowlist: `isAllowedHref` is the same check strict
      // validation and Markdown conversion use, so http/https/mailto, real URL parsing rather than a
      // prefix test, no control characters, no embedded credentials, and a bounded length.
      //
      // Permitted means "passes this policy", never "safe destination". The href reaches the
      // consumer exactly as authored: normalizing it here would hand someone a different address
      // from the one they tapped.
      if (!isAllowedHref(message.href)) {
        return {
          state,
          effects: [{ kind: 'problem', problem: { stage: 'link', sessionId: state.sessionId } }],
        };
      }
      return { state, effects: [{ kind: 'link', href: message.href }] };
    }

    case 'rejected': {
      const effects: SessionEffect[] = [
        {
          kind: 'problem',
          problem: { stage: 'editor', code: message.code, sessionId: state.sessionId },
        },
      ];
      // The live document was never handed over, so the renderer is its only copy.
      const rendererOnly = message.code === 'invalid_document' || message.code === 'too_large';
      let next: SessionState = rendererOnly ? { ...state, rendererOnlyWriting: true } : state;

      const answersBarrier =
        next.barrier !== null &&
        (message.requestId === next.barrier.requestId ||
          // A failed lock can refuse before it ever saw the barrier it was taken for. It is still
          // that barrier's answer: there is only ever one, and it must not wait out its timeout.
          (message.requestId === undefined && message.code === 'composing' && next.barrier.lock));

      if (answersBarrier) {
        const settled = settleBarrier(next, { kind: 'refused', code: message.code });
        next = settled.state;
        effects.push(...settled.effects);
      }
      return { state: next, effects };
    }

    case 'snapshot': {
      if (state.phase !== 'initialized' && state.phase !== 'editing') return { state, effects: [] };

      const failure = inspectSnapshotDocument(message.document);
      if (failure !== undefined) {
        const effects: SessionEffect[] = [
          { kind: 'problem', problem: { stage: 'document', failure, sessionId: state.sessionId } },
        ];
        // The draft is untouched. The barrier still has to end, or a Save would hang on a document
        // the app has already decided it cannot store.
        if (state.barrier !== null && message.requestId === state.barrier.requestId) {
          const settled = settleBarrier(state, { kind: 'refused', code: 'invalid_document' });
          return { state: settled.state, effects: [...effects, ...settled.effects] };
        }
        return { state, effects };
      }

      const snapshot: EditorSnapshot = {
        sessionId: message.sessionId,
        editSeq: message.editSeq,
        document: message.document,
      };
      const correlated =
        state.barrier !== null &&
        message.reason === 'requested' &&
        message.requestId === state.barrier.requestId;

      // A correlated answer may repeat the last accepted sequence: equality means nothing changed,
      // and that confirmation is what settles the wait. Everything else must be strictly newer, so
      // an obsolete or duplicated message cannot overwrite newer work.
      const ordered = correlated
        ? message.editSeq >= state.lastAcceptedSeq
        : message.editSeq > state.lastAcceptedSeq;
      if (!ordered) return { state, effects: [] };

      return acceptSnapshot(state, snapshot, correlated);
    }
  }
};

const canTalkToEditor = (state: SessionState): boolean =>
  state.phase === 'initialized' || state.phase === 'editing';

export const reduce = (state: SessionState, event: SessionEvent): Reduction => {
  switch (event.type) {
    case 'message':
      return onMessage(state, event.raw);

    case 'unprotectedChanged':
      return { state: { ...state, unprotected: event.unprotected }, effects: [] };

    case 'documentReplaced': {
      // An unrelated rerender must not overwrite newer accepted work, so identity decides, not
      // reference equality of the document.
      if (event.documentId === state.documentId) return { state, effects: [] };

      // The session this barrier belonged to is about to be retired, so its lock cannot be released
      // by addressing it; the replacement arrives editable through its own `init`.
      const settled = settleBarrier(state, { kind: 'unanswered' }, { addressable: false });
      const sessionId = settled.state.sessionId + 1;
      const replaced: SessionState = {
        ...settled.state,
        sessionId,
        documentId: event.documentId,
        locked: false,
        lastAcceptedSeq: 0,
        latestAccepted: null,
        rendererOnlyWriting: false,
        pendingDocument: event.document,
      };
      const release: readonly SessionEffect[] = settled.state.locked
        ? [{ kind: 'locked', locked: false }]
        : [];

      // A live renderer can simply be handed the new identity; one that never finished its handshake
      // has nothing to hand it to.
      if (state.phase === 'loading' || state.phase === 'incompatible') {
        return {
          state: { ...replaced, phase: state.phase },
          effects: [...settled.effects, ...release],
        };
      }
      return {
        state: { ...replaced, phase: 'handshaking' },
        effects: [
          ...settled.effects,
          ...release,
          {
            kind: 'send',
            message: {
              type: 'init',
              sessionId,
              document: event.document,
              editable: replaced.editable,
            },
          },
        ],
      };
    }

    case 'rendererTerminated':
      return restart(state);

    case 'barrierRequested': {
      if (!canTalkToEditor(state)) {
        // Nothing was ever loaded, so nothing is known about writing since the last accepted
        // snapshot. That is `unanswered`, not a refusal the editor made.
        return { state, effects: [{ kind: 'barrierRefused', result: { kind: 'unanswered' } }] };
      }
      if (state.barrier !== null) {
        return {
          state,
          effects: [
            { kind: 'barrierRefused', result: { kind: 'refused', code: 'unsupported_message' } },
            {
              kind: 'problem',
              problem: {
                stage: 'editor',
                code: 'unsupported_message',
                sessionId: state.sessionId,
              },
            },
          ],
        };
      }

      const requestId = state.nextRequestId;
      const effects: SessionEffect[] = [];
      // The host's half of the lock: it stops sending before it asks, and says so, because disabled
      // native controls are also the accessible statement that the form is busy.
      const locking = event.lock && state.editable;
      if (locking) {
        effects.push({ kind: 'locked', locked: true });
        effects.push({
          kind: 'send',
          message: { type: 'setEditable', sessionId: state.sessionId, editable: false },
        });
      }
      effects.push({
        kind: 'send',
        message: { type: 'requestSnapshot', sessionId: state.sessionId, requestId },
      });
      effects.push({ kind: 'barrierOpened', requestId });

      return {
        state: {
          ...state,
          barrier: { requestId, lock: event.lock, tookLock: locking && !state.locked },
          nextRequestId: requestId + 1,
          ...(locking ? { locked: true } : {}),
        },
        effects,
      };
    }

    case 'barrierTimedOut': {
      if (state.barrier === null || state.barrier.requestId !== event.requestId) {
        return { state, effects: [] };
      }
      // The host's timeout is the authoritative end of a barrier. A reply for a request no longer
      // awaited can satisfy nothing, which is what keeps a late answer from becoming this one.
      const settled = settleBarrier(state, { kind: 'unanswered' });
      return { state: settled.state, effects: settled.effects };
    }

    case 'barrierCancelled': {
      const settled = settleBarrier(state, { kind: 'unanswered' });
      return { state: settled.state, effects: settled.effects };
    }

    case 'editableRequested': {
      if (!state.editable) {
        // A permanently read-only host has no lock to release. Making it editable is not something
        // an ordinary unlock is allowed to do.
        return {
          state,
          effects: [
            {
              kind: 'problem',
              problem: {
                stage: 'editor',
                code: 'unsupported_message',
                sessionId: state.sessionId,
              },
            },
          ],
        };
      }
      if (!canTalkToEditor(state)) return { state, effects: [] };

      const locked = !event.editable;
      return {
        state: { ...state, locked },
        effects: [
          { kind: 'locked', locked },
          {
            kind: 'send',
            message: {
              type: 'setEditable',
              sessionId: state.sessionId,
              editable: event.editable,
            },
          },
        ],
      };
    }

    case 'commandRequested': {
      if (!state.editable || state.locked || !canTalkToEditor(state)) {
        return {
          state,
          effects: [
            {
              kind: 'problem',
              problem: { stage: 'editor', code: 'locked', sessionId: state.sessionId },
            },
          ],
        };
      }
      return {
        state,
        effects: [
          {
            kind: 'send',
            message: { type: 'command', sessionId: state.sessionId, command: event.command },
          },
        ],
      };
    }
  }
};
