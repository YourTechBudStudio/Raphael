/**
 * The message vocabulary shared by the two execution graphs, and nothing else.
 *
 * This module is imported by the native host (Hermes) and by the browser entry (WebView). It
 * therefore contains data and types only: no React, no DOM, no ProseMirror, no TipTap. If something
 * here ever needs a runtime dependency, it belongs on one side or the other instead.
 */

/** Bumped when the grammar below changes in a way the other side cannot understand. */
export const EDITOR_BRIDGE_VERSION = 1;

/** The largest bridge envelope either side will accept, in UTF-16 code units of the raw string. */
export const BRIDGE_MAX_CHARS = 1_048_576;

/**
 * How long the host waits for an answer to a snapshot barrier.
 *
 * The host's timeout is authoritative: the browser's own deadline below is smaller so that an
 * honest refusal usually beats it, but bridge delivery and event-loop suspension can exceed any
 * margin, so the host must always be able to end the barrier by itself.
 */
export const SNAPSHOT_TIMEOUT_MS = 1500;

/**
 * The browser's bound on a pending lock. Smaller than the host timeout so a `composing` refusal
 * normally arrives before the host gives up; this is a courtesy, not a guarantee.
 */
export const LOCK_DEADLINE_MS = 1300;

/**
 * The quiet window a pending lock waits out. Longer than `prosemirror-view`'s own 20 ms deferred
 * flush, so the transaction a composition produces is observed rather than assumed.
 */
export const LOCK_SETTLE_MS = 50;

/** The compatibility stamp paired between the generated document and the host that loads it. */
export interface EditorStamp {
  readonly bridgeVersion: number;
  readonly contentSchemaVersion: number;
  readonly payloadDigest: string;
}

/**
 * One editing operation. Fifteen variants; `setHeading` carries three levels, so the toolbar
 * presents seventeen independently selectable actions (see `EDITOR_ACTIONS`).
 */
export type EditorCommand =
  | { readonly kind: 'setParagraph' }
  | { readonly kind: 'setHeading'; readonly level: 1 | 2 | 3 }
  | { readonly kind: 'toggleBulletList' }
  | { readonly kind: 'toggleOrderedList' }
  | { readonly kind: 'sinkListItem' }
  | { readonly kind: 'liftListItem' }
  | { readonly kind: 'toggleCodeBlock' }
  | { readonly kind: 'toggleBold' }
  | { readonly kind: 'toggleItalic' }
  | { readonly kind: 'toggleStrike' }
  | { readonly kind: 'toggleCode' }
  | { readonly kind: 'setBlockquote' }
  | { readonly kind: 'insertHorizontalRule' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };

/**
 * The seventeen actions the toolbar offers, which is also the vocabulary of active and available
 * state. Action identity is flatter than command identity on purpose: a control is one action, and
 * three heading levels are three controls.
 */
export const EDITOR_ACTIONS = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'nest',
  'outdent',
  'codeBlock',
  'blockquote',
  'bold',
  'italic',
  'strike',
  'code',
  'horizontalRule',
  'undo',
  'redo',
] as const;

export type EditorActionId = (typeof EDITOR_ACTIONS)[number];

/** The command one action sends. */
export const commandForAction = (action: EditorActionId): EditorCommand => {
  switch (action) {
    case 'paragraph':
      return { kind: 'setParagraph' };
    case 'heading1':
      return { kind: 'setHeading', level: 1 };
    case 'heading2':
      return { kind: 'setHeading', level: 2 };
    case 'heading3':
      return { kind: 'setHeading', level: 3 };
    case 'bulletList':
      return { kind: 'toggleBulletList' };
    case 'orderedList':
      return { kind: 'toggleOrderedList' };
    case 'nest':
      return { kind: 'sinkListItem' };
    case 'outdent':
      return { kind: 'liftListItem' };
    case 'codeBlock':
      return { kind: 'toggleCodeBlock' };
    case 'blockquote':
      return { kind: 'setBlockquote' };
    case 'bold':
      return { kind: 'toggleBold' };
    case 'italic':
      return { kind: 'toggleItalic' };
    case 'strike':
      return { kind: 'toggleStrike' };
    case 'code':
      return { kind: 'toggleCode' };
    case 'horizontalRule':
      return { kind: 'insertHorizontalRule' };
    case 'undo':
      return { kind: 'undo' };
    case 'redo':
      return { kind: 'redo' };
  }
};

/**
 * Which actions apply to the current selection and which of them can run.
 *
 * `available` is not a subset of the schema: it is what `editor.can()` and the history's own depth
 * say right now, so a control can be shown, labelled, and disabled rather than silently doing
 * nothing.
 */
export interface EditorSelectionState {
  readonly active: readonly EditorActionId[];
  readonly available: readonly EditorActionId[];
}

/** Why the browser refused something. No authored content is ever carried with a refusal. */
export type EditorRejectionCode =
  | 'invalid_document'
  | 'unsupported_message'
  | 'too_large'
  | 'locked'
  | 'composing';

/** Native to WebView. Authored content travels only as `document`, always as parsed JSON data. */
export type HostMessage =
  | {
      readonly type: 'init';
      readonly sessionId: number;
      readonly document: unknown;
      readonly editable: boolean;
    }
  | { readonly type: 'requestSnapshot'; readonly sessionId: number; readonly requestId: number }
  | { readonly type: 'command'; readonly sessionId: number; readonly command: EditorCommand }
  | { readonly type: 'setEditable'; readonly sessionId: number; readonly editable: boolean };

/** WebView to native. `ready` is the only message accepted before a session exists. */
export type EditorMessage =
  | {
      readonly type: 'ready';
      readonly bridgeVersion: number;
      readonly contentSchemaVersion: number;
      readonly payloadDigest: string;
    }
  | { readonly type: 'initialized'; readonly sessionId: number }
  | {
      readonly type: 'snapshot';
      readonly sessionId: number;
      readonly editSeq: number;
      readonly document: unknown;
      readonly reason: 'edit' | 'requested';
      readonly requestId?: number;
    }
  | {
      readonly type: 'selection';
      readonly sessionId: number;
      readonly state: EditorSelectionState;
    }
  | {
      readonly type: 'rejected';
      readonly sessionId: number;
      readonly code: EditorRejectionCode;
      readonly requestId?: number;
    }
  | { readonly type: 'link'; readonly sessionId: number; readonly href: string };
