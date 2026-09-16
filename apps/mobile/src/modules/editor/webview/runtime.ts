/**
 * The editor, in the browser. This is the only place a real TipTap editor exists.
 *
 * It owns the schema (the canonical allowlist, plus history, which contributes no node or mark),
 * full canonicalization before anything leaves, the debounce, and the three-part lock. It owns no
 * persistence and no transport: it reports what it has, and native decides what that means.
 *
 * Everything it needs from the outside — the element, how to post, how to time — is a parameter, so
 * the same code runs under `node --test` with a simulated DOM and a controlled clock.
 */

import { CONTENT_SCHEMA_VERSION } from '@raphael/content';
import { canonicalizeDocument, contentExtensions } from '@raphael/content/schema';
import { Editor, type JSONContent } from '@tiptap/core';
import { UndoRedo } from '@tiptap/extensions';
import * as Either from 'effect/Either';

import {
  BRIDGE_MAX_CHARS,
  EDITOR_BRIDGE_VERSION,
  LOCK_DEADLINE_MS,
  LOCK_SETTLE_MS,
  type EditorCommand,
  type EditorMessage,
  type EditorRejectionCode,
} from '../bridge.ts';
import { runCommand, selectionStateOf } from './commands.ts';
import { createLockCoordinator, type LockCoordinator } from './lock.ts';

/** Trailing coalescing window for edit snapshots. */
export const EDIT_DEBOUNCE_MS = 300;

export interface RuntimeTimers {
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface RuntimeOptions {
  /** Where the editor mounts. */
  readonly element: HTMLElement;
  /** How one serialized message leaves. */
  readonly post: (raw: string) => void;
  /** The digest of the document this bundle was embedded in, reported in `ready`. */
  readonly payloadDigest: string;
  readonly timers?: RuntimeTimers | undefined;
  readonly debounceMs?: number | undefined;
  readonly settleMs?: number | undefined;
  readonly deadlineMs?: number | undefined;
}

export interface EditorRuntime {
  /** One raw envelope from the host. */
  readonly receive: (raw: unknown) => void;
  /** Announce the bundle. The host sends nothing until this matches its own stamp. */
  readonly announce: () => void;
  readonly destroy: () => void;
  /** Test seams. Not part of any bridge contract. */
  readonly editor: Editor;
  readonly lock: LockCoordinator;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The canonical allowlist, plus history.
 *
 * `UndoRedo` is added here and only here. TipTap 3 installs no history by default and
 * `contentExtensions()` is the canonical *schema* allowlist, which must not gain nodes or marks; a
 * history plugin contributes neither, so this widens editing without widening what can be stored.
 * The link extension is reconfigured rather than replaced, so the allowlist stays single-sourced —
 * `contentExtensions()` returns a fresh array per call, so nothing shared is mutated.
 */
const editorExtensions = () => [
  ...contentExtensions().map((extension) =>
    extension.name === 'link' ? extension.configure({ openOnClick: false }) : extension,
  ),
  UndoRedo,
];

export const createEditorRuntime = (options: RuntimeOptions): EditorRuntime => {
  const timers: RuntimeTimers = options.timers ?? {
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const debounceMs = options.debounceMs ?? EDIT_DEBOUNCE_MS;

  let sessionId: number | null = null;
  /** A read-only session can never be made editable; only a new `init` changes that. */
  let readOnly = true;
  let locked = true;
  let editSeq = 0;
  let barrier: number | null = null;
  let debounce: unknown = null;
  let selectionPending = false;
  let destroyed = false;

  const editor = new Editor({
    element: options.element,
    extensions: editorExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editable: false,
  });

  const send = (message: EditorMessage): boolean => {
    if (destroyed) return false;
    const raw = JSON.stringify(message);
    if (raw.length > BRIDGE_MAX_CHARS) return false;
    options.post(raw);
    return true;
  };

  const reject = (code: EditorRejectionCode, requestId?: number): void => {
    send({
      type: 'rejected',
      sessionId: sessionId ?? 0,
      code,
      ...(requestId === undefined ? {} : { requestId }),
    });
  };

  const cancelDebounce = (): void => {
    if (debounce !== null) {
      timers.clearTimer(debounce);
      debounce = null;
    }
  };

  /** The canonical form of what is on screen, or the failure that says it cannot be stored. */
  const canonicalize = (): unknown | null => {
    const result = canonicalizeDocument(editor.getJSON());
    return Either.isRight(result) ? result.right : null;
  };

  const sendSnapshot = (reason: 'edit' | 'requested', requestId?: number): void => {
    if (sessionId === null) return;
    const document = canonicalize();
    if (document === null) {
      // A document the editor could produce but core would refuse never becomes an accepted version.
      // The renderer keeps it so it can be brought back into range; nothing here repairs or drops it.
      reject('invalid_document', requestId);
      return;
    }
    const message: EditorMessage = {
      type: 'snapshot',
      sessionId,
      editSeq,
      document,
      reason,
      ...(requestId === undefined ? {} : { requestId }),
    };
    if (!send(message)) reject('too_large', requestId);
  };

  const answerBarrier = (requestId: number): void => {
    cancelDebounce();
    sendSnapshot('requested', requestId);
  };

  const lock = createLockCoordinator(
    {
      settleMs: options.settleMs ?? LOCK_SETTLE_MS,
      deadlineMs: options.deadlineMs ?? LOCK_DEADLINE_MS,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    },
    {
      isComposing: () => editor.view.composing,
      onLocked: () => {
        locked = true;
        // Only now is `contenteditable` touched. Once this has happened no further edit snapshot can
        // be generated from any source, so the document the barrier reports is the last word.
        //
        // The second argument matters: `setEditable` emits `update` by default, which would make
        // taking the lock look like an authored change and produce a snapshot of its own.
        editor.setEditable(false, false);
        const waiting = barrier;
        barrier = null;
        if (waiting !== null) answerBarrier(waiting);
      },
      onFailed: () => {
        // Honest refusal, editor still live and editable. The retained barrier is the one this lock
        // was taken for, so it is answered rather than left to time out.
        const waiting = barrier;
        barrier = null;
        reject('composing', waiting ?? undefined);
      },
    },
  );

  const scheduleSelection = (): void => {
    if (selectionPending || sessionId === null) return;
    selectionPending = true;
    timers.setTimer(() => {
      selectionPending = false;
      if (destroyed || sessionId === null) return;
      send({ type: 'selection', sessionId, state: selectionStateOf(editor) });
    }, 0);
  };

  // `transaction` fires even for a change that carries `preventUpdate`, which is what initialization
  // uses. So the lock's quiet window watches transactions - it must notice everything that touches
  // the document - while the authored-change path listens to `update`, which initialization does not
  // emit. That is how `emitUpdate: false` cannot author a change or produce a snapshot.
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) lock.noteTransaction();
    scheduleSelection();
  });

  editor.on('update', () => {
    editSeq += 1;
    cancelDebounce();
    debounce = timers.setTimer(() => {
      debounce = null;
      sendSnapshot('edit');
    }, debounceMs);
  });

  const onCompositionStart = () => lock.noteCompositionStart();
  const onCompositionEnd = () => lock.noteCompositionEnd();
  options.element.addEventListener('compositionstart', onCompositionStart);
  options.element.addEventListener('compositionend', onCompositionEnd);

  /**
   * A link tap is reported, never followed. The editor never navigates to an authored URL: native
   * applies its own safe-protocol policy to the href, and the href crosses the bridge as ordinary
   * validated, session-correlated data like every other message.
   */
  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    const href = anchor?.getAttribute('href');
    if (href === null || href === undefined || href === '') return;
    event.preventDefault();
    if (sessionId !== null) send({ type: 'link', sessionId, href });
  };
  options.element.addEventListener('click', onClick);

  const applyInit = (document: unknown, editable: boolean): void => {
    const canonical = canonicalizeDocument(document);
    if (Either.isLeft(canonical)) {
      // An invalid initialization retains the supplied draft rather than repairing it: nothing is
      // loaded, and the host hears why.
      reject('invalid_document');
      return;
    }
    lock.cancel();
    cancelDebounce();
    editSeq = 0;
    barrier = null;
    readOnly = !editable;
    locked = !editable;
    // `emitUpdate: false` is what stops initialization authoring a change or producing a snapshot.
    // `addToHistory: false` is what stops it becoming an undo step: without it the first undo would
    // undo the load itself and empty the document, which is not a change anyone made.
    editor
      .chain()
      .setContent(canonical.right as unknown as JSONContent, { emitUpdate: false })
      .setMeta('addToHistory', false)
      .run();
    editor.setEditable(editable, false);
    if (sessionId !== null) send({ type: 'initialized', sessionId });
    scheduleSelection();
  };

  const handle = (message: Record<string, unknown>): void => {
    if (message.type === 'init') {
      if (typeof message.sessionId !== 'number' || typeof message.editable !== 'boolean') {
        reject('unsupported_message');
        return;
      }
      sessionId = message.sessionId;
      applyInit(message.document, message.editable);
      return;
    }

    if (message.sessionId !== sessionId || sessionId === null) return;

    switch (message.type) {
      case 'requestSnapshot': {
        if (typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)) {
          reject('unsupported_message');
          return;
        }
        if (barrier !== null) {
          // One outstanding barrier per host. A second is a protocol misuse, refused against its own
          // correlation so the caller settles rather than waiting on an answer that cannot come.
          reject('unsupported_message', message.requestId);
          return;
        }
        if (lock.isPending()) {
          // Retained, not queued: it is answered when the lock resolves, either way.
          barrier = message.requestId;
          return;
        }
        answerBarrier(message.requestId);
        return;
      }

      case 'setEditable': {
        if (typeof message.editable !== 'boolean') {
          reject('unsupported_message');
          return;
        }
        if (message.editable) {
          if (readOnly) {
            // An ordinary unlock must never make a permanently read-only host editable.
            reject('unsupported_message');
            return;
          }
          lock.cancel();
          locked = false;
          editor.setEditable(true, false);
          return;
        }
        if (readOnly || locked) return;
        // Becomes pending, not applied: the editor stays editable throughout, which is the point —
        // `contenteditable` is never toggled under a live IME.
        lock.request();
        return;
      }

      case 'command': {
        if (!isRecord(message.command) || typeof message.command.kind !== 'string') {
          reject('unsupported_message');
          return;
        }
        if (readOnly || locked || lock.isPending()) {
          // The invariant behind the host's hint: a command that races the lock cannot mutate the
          // document, whatever the host believed when it sent it. Refused commands are not replayed.
          reject('locked');
          return;
        }
        runCommand(editor, message.command as unknown as EditorCommand);
        return;
      }

      default:
        reject('unsupported_message');
    }
  };

  return {
    receive: (raw: unknown) => {
      if (destroyed) return;
      if (typeof raw !== 'string' || raw.length > BRIDGE_MAX_CHARS) {
        reject('too_large');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject('unsupported_message');
        return;
      }
      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        reject('unsupported_message');
        return;
      }
      handle(parsed);
    },
    announce: () => {
      send({
        type: 'ready',
        bridgeVersion: EDITOR_BRIDGE_VERSION,
        contentSchemaVersion: CONTENT_SCHEMA_VERSION,
        payloadDigest: options.payloadDigest,
      });
    },
    destroy: () => {
      destroyed = true;
      cancelDebounce();
      lock.cancel();
      options.element.removeEventListener('compositionstart', onCompositionStart);
      options.element.removeEventListener('compositionend', onCompositionEnd);
      options.element.removeEventListener('click', onClick);
      editor.destroy();
    },
    editor,
    lock,
  };
};
