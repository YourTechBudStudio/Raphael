import type {
  AttemptCheck,
  ContainerTarget,
  CreateContainerOutcome,
  PendingAttempt,
} from './types';

/**
 * The creation sheet's state, as a pure machine.
 *
 * The thing this protects is the identity of an attempt. Once a request has left the phone, its
 * fields and key are a fact about the world: the server may have acted on them. So every field is
 * locked while the outcome is unknown, a retry resends the same key, and only a definite answer
 * (created, or refused) lets the next attempt be a new one. Editing never silently turns an
 * already dispatched attempt into a different request.
 */

export type CreationPhase =
  /** Typing, or looking at why the last attempt was refused. */
  | { kind: 'editing'; problem: string | null; notice: string | null }
  /** A request is in flight. */
  | { kind: 'saving' }
  /** The request left but no answer came. The title is locked; three ways forward. */
  | { kind: 'uncertain'; checking: boolean }
  /** The server can no longer say. Look first, then create again explicitly. */
  | { kind: 'expired' }
  /** Done; the host closes the sheet and opens the result. */
  | { kind: 'created' };

/** The authored fields of one attempt. Only the title is required. */
export interface CreationDraft {
  title: string;
  description: string;
  /** Markdown source, as written. */
  body: string;
}

export type CreationField = keyof CreationDraft;

export interface CreationState extends CreationDraft {
  target: ContainerTarget;
  /** Null until a request is sent; kept across retries; cleared by a definite refusal. */
  attemptKey: string | null;
  phase: CreationPhase;
}

export type CreationEvent =
  | { type: 'edit'; field: CreationField; value: string }
  /** Save pressed. `key` is used only when this is a new logical attempt. */
  | { type: 'submit'; key: string }
  /** The local record of the attempt could not be written, so nothing was sent. */
  | { type: 'record_failed' }
  | { type: 'outcome'; outcome: CreateContainerOutcome }
  | { type: 'check' }
  | { type: 'check_result'; result: AttemptCheck }
  /** The check itself got no answer. Nothing is known that was not known before. */
  | { type: 'check_failed' }
  | { type: 'retry' }
  /** After expiry: the person has looked, and wants to create it again as a new attempt. */
  | { type: 'start_over' };

export const EMPTY_TITLE_PROBLEM = 'Give it a title.';
export const RECORD_FAILED_PROBLEM =
  'Raphael could not keep a record of this attempt on this phone, so it was not sent. Save again to try.';
export const NOT_CREATED_NOTICE = 'It was not created. Save sends the same attempt again.';
export const AFTER_EXPIRY_NOTICE =
  'This is a new attempt. The earlier one may have gone through, so check for a duplicate afterwards.';

const editing = (problem: string | null = null, notice: string | null = null): CreationPhase => ({
  kind: 'editing',
  problem,
  notice,
});

export const initialCreation = (target: ContainerTarget): CreationState => ({
  target,
  title: '',
  description: '',
  body: '',
  attemptKey: null,
  phase: editing(),
});

/** Reopening on an attempt that was closed while unresolved, with its payload untouched. */
export const resumedCreation = (attempt: PendingAttempt): CreationState => ({
  target: { type: attempt.type, parentAreaId: attempt.parentAreaId },
  title: attempt.title,
  description: attempt.description,
  body: attempt.body,
  attemptKey: attempt.attemptKey,
  phase: { kind: 'uncertain', checking: false },
});

/** What an attempt would send: the draft, trimmed the way it is stored. */
export const draftOf = (state: CreationState): CreationDraft => ({
  title: state.title.trim(),
  description: state.description.trim(),
  body: state.body.trim(),
});

/** Whether anything has been written, for deciding if closing discards work. */
export const hasContent = (state: CreationState): boolean => {
  const draft = draftOf(state);

  return draft.title !== '' || draft.description !== '' || draft.body !== '';
};

export const reduceCreation = (state: CreationState, event: CreationEvent): CreationState => {
  switch (event.type) {
    case 'edit': {
      if (state.phase.kind !== 'editing') return state;
      // A refusal ends the attempt it refused; typing after it is the start of a new one.
      return { ...state, [event.field]: event.value, attemptKey: null, phase: editing() };
    }
    case 'submit': {
      if (state.phase.kind !== 'editing') return state;
      if (state.title.trim() === '') {
        return { ...state, phase: editing(EMPTY_TITLE_PROBLEM) };
      }
      return { ...state, attemptKey: state.attemptKey ?? event.key, phase: { kind: 'saving' } };
    }
    case 'record_failed': {
      if (state.phase.kind !== 'saving') return state;
      // Nothing left the phone, so this is still the same not-yet-sent attempt.
      return { ...state, phase: editing(RECORD_FAILED_PROBLEM) };
    }
    case 'outcome': {
      if (state.phase.kind !== 'saving') return state;
      switch (event.outcome.kind) {
        case 'created':
          return { ...state, phase: { kind: 'created' } };
        case 'rejected':
          // Definite. The title stays for correcting; the key is spent.
          return { ...state, attemptKey: null, phase: editing(event.outcome.message) };
        case 'uncertain':
          return { ...state, phase: { kind: 'uncertain', checking: false } };
      }
      break;
    }
    case 'check': {
      if (state.phase.kind !== 'uncertain' || state.phase.checking) return state;
      return { ...state, phase: { kind: 'uncertain', checking: true } };
    }
    case 'check_result': {
      if (state.phase.kind !== 'uncertain') return state;
      switch (event.result.kind) {
        case 'created':
          return { ...state, phase: { kind: 'created' } };
        case 'not_created':
          // Known not to exist, so the same key can safely be sent again from the editor.
          return { ...state, phase: editing(null, NOT_CREATED_NOTICE) };
        case 'expired':
          return { ...state, phase: { kind: 'expired' } };
      }
      break;
    }
    case 'check_failed': {
      if (state.phase.kind !== 'uncertain') return state;
      return { ...state, phase: { kind: 'uncertain', checking: false } };
    }
    case 'retry': {
      if (state.phase.kind !== 'uncertain' || state.phase.checking) return state;
      return { ...state, phase: { kind: 'saving' } };
    }
    case 'start_over': {
      if (state.phase.kind !== 'expired') return state;
      return { ...state, attemptKey: null, phase: editing(null, AFTER_EXPIRY_NOTICE) };
    }
  }
  return state;
};

/** Whether the fields accept typing. Locked from the moment a request leaves. */
export const isDraftEditable = (state: CreationState): boolean => state.phase.kind === 'editing';

/** Whether closing the sheet should leave a pending attempt behind rather than discard. */
export const leavesPendingAttempt = (state: CreationState): boolean =>
  state.phase.kind === 'uncertain' || state.phase.kind === 'expired';

/** The one sentence over the locked title while the outcome is unknown. */
export const describeUncertain = (title: string, checking: boolean): string =>
  checking
    ? `Asking the server whether ${title} was created…`
    : `Raphael can't tell whether ${title} was created. The request left, and no answer came back.`;

/** After expiry, the only honest instruction. */
export const describeExpired = (title: string, parentName: string | null): string =>
  `Too long has passed for the server to say whether ${title} was created. Look ${
    parentName === null ? 'at the top level' : `in ${parentName}`
  } before creating it again.`;

/**
 * A key for a new logical attempt. Random enough for an idempotency key: a collision would need
 * two attempts on one phone to draw the same 122 random bits. The fallback covers runtimes
 * without `crypto.randomUUID`, using more entropy than a timestamp alone would carry.
 */
export const newAttemptKey = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  const part = () => Math.random().toString(36).slice(2, 12);
  return `${String(Date.now())}-${part()}-${part()}-${part()}`;
};
