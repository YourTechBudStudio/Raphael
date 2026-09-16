/**
 * What capture stores, and what it means.
 *
 * Two records, deliberately separate. A **draft** is editable local work: authored fields, where it
 * is going, which connection it belongs to, and how far along its own version counter it is. An
 * **attempt** is an immutable question asked of one server: the exact bytes, the key, the version
 * those bytes answer for, and the history of what has been observed about it.
 *
 * Neither substitutes for the other, and the separation is the point. A draft can be discarded while
 * an attempt survives, because discarding writing cannot un-ask a question. An attempt can be
 * acknowledged and consumed while the draft keeps its `created` state, because that state is what
 * stops a second creation for the same writing after the receipt is gone.
 *
 * `firstUncertainAt` carries the weight: `mutationOutcome` answers for one HTTP attempt, and this
 * answers for the creation. A first dispatch can commit and lose its answer, and a replay under the
 * same key can then take a perfectly valid refusal - that refusal is about the replay, while the
 * creation remains genuinely unresolved. Once set, only deleting the row clears it.
 */

import type { NodeEntity, ResourceKind } from '@raphael/contracts/nodes';

import type { ContainerRef } from '../../infrastructure/api/contracts';

/** Where a note goes. A stable `{type, id}` reference, never a copied hierarchy record. */
export type Destination = ContainerRef;

/**
 * How far a draft's own content has got. Never a claim about the server.
 *
 * `created` plus `serverNodeId` is the durable guard of §8.6: it survives receipt consumption, it
 * survives a restart, and it is written in the same transaction as the acknowledgement, so there is
 * no moment where a creation is recorded in only one of the two places.
 */
export type DraftState = 'composing' | 'submitted' | 'created';

/** Where an attempt has got to, as stored. `blocked` is a fact about one attempt, not a verdict. */
export type AttemptState = 'dispatch_intent' | 'uncertain' | 'blocked' | 'acknowledged';

/** What an attempt means, as opposed to where it has got to. Derived, never stored. */
export type LogicalState =
  /** Known to have created nothing. A correction may replace it under a new key. */
  | 'refused'
  /** It may or may not exist. The frozen request and its key stay exactly as they are. */
  | 'unresolved'
  /** Known server success, whether written down here yet or not. */
  | 'created';

/**
 * What the last attempt did, as a controlled projection.
 *
 * Assembled from values this app recognizes - never an exception, a raw envelope, or a decoder
 * string relabelled as safe. `message` is our own wording or a `ClientFailure.message`, which the
 * shared client already guarantees carries no credential, body, or decoder text.
 */
export interface AttemptOutcome {
  readonly kind:
    | 'rejected'
    | 'not_dispatched'
    | 'unknown'
    | 'unusable_payload'
    | 'acknowledgement_unsaved';
  /** The server's classified error code, when there was a well-formed envelope. */
  readonly code: string | null;
  readonly message: string;
  readonly at: number;
}

/**
 * The saved server answer, kept whole.
 *
 * The full validated entity rather than four card fields, because recovery has to be able to say
 * what was actually created and Phase 06 seeds the resource cache from it without a second request.
 * It is stored as the response the contract decoded and re-validated with the same decoder on the
 * way out, so a row that no longer decodes is unreadable rather than plausible.
 */
export interface AcknowledgedNote {
  readonly id: number;
  readonly revision: number;
  readonly title: string;
  readonly kind: ResourceKind;
  readonly entity: NodeEntity;
}

export interface NoteDraftRecord {
  readonly draftId: string;
  /** The connection this belongs to. Never rewritten onto another one. */
  readonly connectionId: string;
  /** Identification only. Never matched against a current connection to infer sameness. */
  readonly endpoint: string;
  readonly state: DraftState;
  /** May be empty: core resolves a title from content when none was written. */
  readonly title: string;
  readonly description: string;
  /** The canonical TipTap document, as last committed. */
  readonly document: unknown;
  readonly contentSchemaVersion: number;
  readonly destination: Destination | null;
  /** Every authored field participates in this, so a title edit is protected like a body edit. */
  readonly draftVersion: number;
  /** The exact version a frozen request answers for, once one has been dispatched. */
  readonly submittedVersion: number | null;
  readonly serverNodeId: number | null;
  readonly serverRevision: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Why a stored draft cannot be opened in this build.
 *
 * Kept apart from the usable records rather than folded into a count, because these are three
 * different sentences and one of them must never be "there is nothing unfinished".
 */
export type DraftProblem =
  /** Columns are not what they claim to be. */
  | 'unreadable_row'
  /** Written under a different content schema. Retained, never migrated or downgraded. */
  | 'unsupported_content_schema'
  /** The stored body does not survive this build's structural validation. */
  | 'unusable_body';

/** A retained draft this build cannot open, with just enough to name it in a recovery list. */
export interface UnusableDraft {
  readonly draftId: string;
  readonly connectionId: string | null;
  readonly endpoint: string | null;
  /** The title column, read as plain text. Empty is a legitimate title, not a failure to read one. */
  readonly title: string | null;
  readonly contentSchemaVersion: number | null;
  readonly problem: DraftProblem;
}

export interface NoteAttemptRecord {
  readonly attemptId: string;
  /** The draft these bytes came from. Not a foreign key: the draft may be gone. */
  readonly draftId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly state: AttemptState;
  /** The frozen normalized request, as JSON text. Never rewritten. */
  readonly request: string;
  /** Which exact draft version these bytes are. A receipt answers for this and nothing later. */
  readonly submittedDraftVersion: number;
  /** Written once at freeze time. A recovery label; may be empty. */
  readonly title: string;
  readonly destination: Destination;
  readonly firstDispatchAt: number;
  readonly firstUncertainAt: number | null;
  /** True once time has been observed moving backwards for this attempt. Never cleared. */
  readonly clockAnomaly: boolean;
  readonly lastOutcome: AttemptOutcome | null;
  readonly acknowledged: AcknowledgedNote | null;
  /**
   * The highest wall-clock time this attempt has been seen at, not merely its last write. It only
   * moves forward: a clock set back an hour is invisible against the first dispatch and obvious
   * against this.
   */
  readonly observedAt: number;
}
