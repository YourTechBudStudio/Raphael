/**
 * What the composer says and what its bar may do, as one expression.
 *
 * Pure, and separate from the screen for the reason the policy is separate from the owner: the
 * precedence here is a correctness rule, not a layout choice. Protection outranks everything,
 * because a screen that reports "Saving to your server…" over writing this phone could not keep is
 * telling someone their work is safe in the one moment it is not. A server verdict outranks the
 * ordinary states for the same reason in miniature.
 *
 * Nothing here decides whether a request may be sent. `Standing` decides that, inside the owner;
 * this reads the answer and writes the sentence.
 */

import type { EditorRejectionCode } from '../editor';
import type { DraftProtection } from './owner.ts';
import type { Standing } from './policy.ts';

export type StatusTone = 'quiet' | 'alert';

export interface ComposerStatus {
  readonly text: string;
  readonly tone: StatusTone;
}

/** What the pill on the right of the bar is, right now. */
export type ComposerActionKind = 'save' | 'retry' | 'record_again' | 'none';

export interface ComposerAction {
  readonly kind: ComposerActionKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly hint: string;
}

/**
 * How this phone is failing to protect the writing, when it is.
 *
 * Three cases, and they take different repairs. A local write that failed can be tried again. A
 * document the editor will not hand over can only be cut down or undone. And an editor that did not
 * answer at all is neither: native does not know what is on screen, and asking again is the remedy.
 *
 * The third is deliberately its own sentence rather than being folded into the first. "Raphael could
 * not write your change to this phone" and "the editor did not answer" are different facts, and the
 * design's two frozen sentences cover the two cases it explored - not this one, which the same
 * mechanism produces and which must not be described as something it is not.
 */
export type ProtectionProblem = 'failed_write' | 'too_large' | 'unanswered';

export interface ComposerView {
  readonly status: ComposerStatus;
  readonly action: ComposerAction;
  /** True while a request is in flight: every field, the toolbar and the chip are disabled. */
  readonly locked: boolean;
  /** Present when the writing on screen is not safely on this phone. */
  readonly problem: ProtectionProblem | null;
  /** The destination cannot be changed once a frozen request answers for it. */
  readonly destinationFrozen: boolean;
}

export const PROTECTION_COPY: Record<ProtectionProblem, string> = {
  failed_write: 'Not protected · the last change could not be written to this phone',
  too_large: 'Not protected · too large to keep on this phone',
  unanswered:
    'Not protected · the editor did not answer, so anything since the last saved change is unknown',
};

export const UNCONFIRMED_STATUS = 'Last save not confirmed · Retry to check';
export const WITHDRAWN_STATUS = 'Save not confirmed · kept on this phone';
export const REFUSED_STATUS = 'Your server refused the last save · kept on this phone';
export const UNRECORDED_STATUS = 'On your server · not yet recorded on this phone';
export const SAVING_STATUS = 'Saving to your server…';
export const KEPT_STATUS = 'Kept on this phone as you write';
export const INCONSISTENT_STATUS =
  'Raphael cannot tell what happened to the last save · kept on this phone';

/** The note is filed, and this screen is showing writing the server has not been given. */
export const remainderStatus = (revision: number): string =>
  `On your server · revision ${String(revision)} · newer writing kept on this phone`;

export const serverStatus = (revision: number): string =>
  `On your server · revision ${String(revision)}`;

export interface ComposerInput {
  readonly standing: Standing | null;
  readonly protection: DraftProtection | undefined;
  /** The last thing the renderer refused, when a flush was refused rather than unanswered. */
  readonly lastRejection: EditorRejectionCode | null;
  /** True between admission and the answer. */
  readonly saving: boolean;
  /** A title, a description, or a body with something in it. Core owns the final word on titles. */
  readonly hasContent: boolean;
  readonly hasDestination: boolean;
  /** The revision the server holds for this note, once it holds one. */
  readonly revision: number | null;
  /** True when the draft still holds writing the server was not given. */
  readonly hasRemainder: boolean;
}

/**
 * Why the writing is unprotected, or null.
 *
 * `rendererUnknown` is set by both a refusal and a silence, and the two are told apart by whether a
 * rejection came with it. Either way native provably does not hold what is on screen, so either way
 * Save is refused - by the owner as well as by this - and the status says which it is. The flag
 * clears the moment the editor answers anything, so a slow renderer that comes back is not left
 * looking broken.
 */
const problemOf = (input: ComposerInput): ProtectionProblem | null => {
  if (input.protection?.failedWrite === true) return 'failed_write';
  if (!(input.protection?.rendererUnknown ?? false)) return null;
  if (input.lastRejection === null) return 'unanswered';

  return input.lastRejection === 'too_large' ? 'too_large' : 'failed_write';
};

const NO_ACTION: ComposerAction = { kind: 'none', label: '', enabled: false, hint: '' };

export const composerView = (input: ComposerInput): ComposerView => {
  const problem = problemOf(input);
  const standing = input.standing;
  const locked = input.saving;
  const destinationFrozen =
    standing !== null && standing.kind !== 'save' && standing.kind !== 'save_replacing';

  const action = ((): ComposerAction => {
    if (standing === null) return NO_ACTION;

    switch (standing.kind) {
      case 'save':
      case 'save_replacing':
        return {
          kind: 'save',
          label: input.saving ? 'Saving…' : 'Save',
          // Unprotected writing cannot be saved: sending a version this phone could not keep would
          // mean the server holding something the person can never get back to here.
          enabled: !input.saving && problem === null && input.hasContent && input.hasDestination,
          hint: 'Creates this note on your server',
        };
      case 'retry':
        return {
          kind: 'retry',
          label: input.saving ? 'Sending…' : 'Retry',
          enabled: !input.saving,
          hint: 'Sends exactly the same request again',
        };
      case 'record_again':
        return {
          kind: 'record_again',
          label: input.saving ? 'Saving…' : 'Record it again',
          enabled: !input.saving,
          hint: 'Writes the server’s answer to this phone again',
        };
      case 'blocked':
        return NO_ACTION;
    }
  })();

  const status = ((): ComposerStatus => {
    // Protection first, always. Everything below it is a statement about a server, and none of them
    // is worth saying over "what you have written is not safe here".
    if (problem !== null) return { text: PROTECTION_COPY[problem], tone: 'alert' };
    if (input.saving && standing?.kind === 'save') return { text: SAVING_STATUS, tone: 'quiet' };
    if (standing === null) return { text: KEPT_STATUS, tone: 'quiet' };

    switch (standing.kind) {
      case 'retry':
        return { text: UNCONFIRMED_STATUS, tone: 'alert' };
      case 'record_again':
        return { text: UNRECORDED_STATUS, tone: 'alert' };
      case 'save_replacing':
        return { text: REFUSED_STATUS, tone: 'alert' };
      case 'blocked':
        if (standing.reason === 'created') {
          const revision = input.revision ?? 0;

          return {
            text: input.hasRemainder ? remainderStatus(revision) : serverStatus(revision),
            tone: 'quiet',
          };
        }
        if (standing.reason === 'inconsistent') {
          return { text: INCONSISTENT_STATUS, tone: 'alert' };
        }

        // Unresolved with the replay withdrawn. The sentence must not become "not saved": the
        // server may well hold it, and only the way to ask again has gone.
        return { text: WITHDRAWN_STATUS, tone: 'alert' };
      case 'save':
        return { text: input.saving ? SAVING_STATUS : KEPT_STATUS, tone: 'quiet' };
    }
  })();

  return { status, action, locked, problem, destinationFrozen };
};
