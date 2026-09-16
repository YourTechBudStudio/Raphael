/**
 * The native side of the bridge grammar: what arrives from the WebView, and what may be sent to it.
 *
 * Everything here runs in Hermes, so it imports `@raphael/content/validation` and never
 * `@raphael/content/schema`. Structural acceptance is explicitly not a claim of canonical validity:
 * the ProseMirror content model is enforced in the WebView, which canonicalizes before sending, and
 * again by core on Save. Passing here is a necessary condition, never an acceptance.
 */

import type { ContentFailure } from '@raphael/content';
import { findDocumentFailure, inspectDocumentTransport } from '@raphael/content/validation';

import {
  BRIDGE_MAX_CHARS,
  EDITOR_ACTIONS,
  type EditorActionId,
  type EditorMessage,
  type EditorRejectionCode,
  type EditorSelectionState,
  type HostMessage,
} from '../bridge.ts';

/** Why an envelope never became a message. Deliberately coarse: it is a diagnostic, not content. */
export type EnvelopeRefusal = 'too_large' | 'unparsable' | 'unsupported_message';

export type EnvelopeResult =
  | { readonly kind: 'message'; readonly message: EditorMessage }
  | { readonly kind: 'refused'; readonly refusal: EnvelopeRefusal };

const refused = (refusal: EnvelopeRefusal): EnvelopeResult => ({ kind: 'refused', refusal });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const REJECTION_CODES: readonly EditorRejectionCode[] = [
  'invalid_document',
  'unsupported_message',
  'too_large',
  'locked',
  'composing',
];

const ACTION_IDS: ReadonlySet<string> = new Set(EDITOR_ACTIONS);

const isActionList = (value: unknown): value is readonly EditorActionId[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string' && ACTION_IDS.has(entry));

const isSelectionState = (value: unknown): value is EditorSelectionState =>
  isRecord(value) && isActionList(value.active) && isActionList(value.available);

/** An optional `requestId` is either absent or a safe non-negative integer. */
const requestIdOf = (value: unknown): { readonly ok: boolean; readonly requestId?: number } => {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { ok: false };
  return { ok: true, requestId: value };
};

const isSessionId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Turns one raw `onMessage` payload into a message, in the order the design fixes: size before
 * parse, parse inside `try`, then the shape. A refusal never carries any part of the payload.
 */
export const receiveEnvelope = (raw: unknown): EnvelopeResult => {
  if (typeof raw !== 'string') return refused('unsupported_message');
  // Before parsing, not after: an oversized envelope must not be handed to `JSON.parse` at all.
  if (raw.length > BRIDGE_MAX_CHARS) return refused('too_large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refused('unparsable');
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') return refused('unsupported_message');

  switch (parsed.type) {
    case 'ready': {
      if (
        typeof parsed.bridgeVersion !== 'number' ||
        typeof parsed.contentSchemaVersion !== 'number' ||
        typeof parsed.payloadDigest !== 'string'
      ) {
        return refused('unsupported_message');
      }
      return {
        kind: 'message',
        message: {
          type: 'ready',
          bridgeVersion: parsed.bridgeVersion,
          contentSchemaVersion: parsed.contentSchemaVersion,
          payloadDigest: parsed.payloadDigest,
        },
      };
    }
    case 'initialized': {
      if (!isSessionId(parsed.sessionId)) return refused('unsupported_message');
      return { kind: 'message', message: { type: 'initialized', sessionId: parsed.sessionId } };
    }
    case 'snapshot': {
      const correlation = requestIdOf(parsed.requestId);
      if (
        !isSessionId(parsed.sessionId) ||
        !Number.isSafeInteger(parsed.editSeq) ||
        typeof parsed.editSeq !== 'number' ||
        parsed.editSeq < 0 ||
        (parsed.reason !== 'edit' && parsed.reason !== 'requested') ||
        !correlation.ok
      ) {
        return refused('unsupported_message');
      }
      if (!('document' in parsed)) return refused('unsupported_message');
      return {
        kind: 'message',
        message: {
          type: 'snapshot',
          sessionId: parsed.sessionId,
          editSeq: parsed.editSeq,
          document: parsed.document,
          reason: parsed.reason,
          ...(correlation.requestId === undefined ? {} : { requestId: correlation.requestId }),
        },
      };
    }
    case 'selection': {
      if (!isSessionId(parsed.sessionId) || !isSelectionState(parsed.state)) {
        return refused('unsupported_message');
      }
      return {
        kind: 'message',
        message: {
          type: 'selection',
          sessionId: parsed.sessionId,
          state: { active: [...parsed.state.active], available: [...parsed.state.available] },
        },
      };
    }
    case 'rejected': {
      const correlation = requestIdOf(parsed.requestId);
      if (
        !isSessionId(parsed.sessionId) ||
        typeof parsed.code !== 'string' ||
        !REJECTION_CODES.includes(parsed.code as EditorRejectionCode) ||
        !correlation.ok
      ) {
        return refused('unsupported_message');
      }
      return {
        kind: 'message',
        message: {
          type: 'rejected',
          sessionId: parsed.sessionId,
          code: parsed.code as EditorRejectionCode,
          ...(correlation.requestId === undefined ? {} : { requestId: correlation.requestId }),
        },
      };
    }
    case 'link': {
      if (!isSessionId(parsed.sessionId) || typeof parsed.href !== 'string') {
        return refused('unsupported_message');
      }
      // The href is not trusted here and is not a navigation: native applies its own URL policy.
      if (parsed.href.length > BRIDGE_MAX_CHARS) return refused('too_large');
      return {
        kind: 'message',
        message: { type: 'link', sessionId: parsed.sessionId, href: parsed.href },
      };
    }
    default:
      return refused('unsupported_message');
  }
};

/**
 * The structural gate a snapshot must pass before it can be accepted, in the fixed order: JSON
 * safety and bounds, then the supported vocabulary, marks, attributes and link policy.
 */
export const inspectSnapshotDocument = (document: unknown): ContentFailure | undefined =>
  inspectDocumentTransport(document) ?? findDocumentFailure(document);

/**
 * The script that delivers one host message.
 *
 * The message is serialized whole and parsed as data on the other side, so authored content never
 * becomes source. `injectJavaScript` evaluates what it is given, hence the trailing `true;`, which
 * keeps iOS from trying to serialize a return value back across the bridge.
 */
export const encodeHostMessage = (message: HostMessage): string => {
  // `JSON.stringify` leaves U+2028 and U+2029 unescaped, and both are line terminators in JavaScript
  // source: a note containing one would otherwise break the injected statement in half.
  const literal = JSON.stringify(JSON.stringify(message))
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `window.__raphaelEditor.receive(${literal});true;`;
};

/** Whether a host message fits the envelope bound. An oversized `init` is never injected. */
export const hostMessageFits = (message: HostMessage): boolean =>
  JSON.stringify(message).length <= BRIDGE_MAX_CHARS;
