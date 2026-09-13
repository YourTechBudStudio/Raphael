/**
 * What one creation attempt is, on this device, durably.
 *
 * The record is the unit, not the sheet. A sheet is a view that can be closed, reopened, or killed
 * with the process; the attempt is a fact about a request that may already have reached a server, and
 * it has to outlive all three. So everything needed to resolve it later lives here, and nothing here
 * is reconstructed from what is on screen.
 *
 * Two fields carry most of the weight.
 *
 * `request` is the frozen wire request, normalized once and never rewritten. Resolving an attempt
 * means resending exactly what was sent, and a payload reassembled from current form state is a
 * different logical request wearing the same key.
 *
 * `firstUncertainAt` is the attempt's history, and it is monotonic. `mutationOutcome` answers for one
 * HTTP attempt; this answers for the creation. A first dispatch can commit and lose its answer, and a
 * retry against the same key can then take a valid 401 - that retry was genuinely rejected while the
 * creation is still genuinely unresolved. Once set, only deleting the row clears it.
 */

import type { ContainerType } from '../../../infrastructure/api/contracts';

/**
 * What a creation makes and where. The root holds only areas, so a null parent implies an area.
 */
export interface ContainerTarget {
  type: ContainerType;
  parentAreaId: number | null;
}

/**
 * Where an attempt has got to, as stored.
 *
 * `blocked` rather than `rejected` on purpose. "Rejected" is a claim about the entity, and a row only
 * ever knows what happened to an attempt; whether the creation is refused or merely unresolved is
 * decided by reading this together with `firstUncertainAt`, which is what `logicalStateOf` does.
 */
export type AttemptState =
  /** Written before the request is sent. Its presence never proves the request left the phone. */
  | 'dispatch_intent'
  /** A dispatch answered `unknown`, or the startup sweep adopted an interrupted intent. */
  | 'uncertain'
  /** A controlled unsuccessful attempt. `lastOutcome` separates refused from never-sent. */
  | 'blocked'
  /** A validated server success. Never resent. */
  | 'acknowledged';

/**
 * What the last attempt did, as a controlled projection.
 *
 * Assembled from values this app recognizes - never an exception, a raw error envelope, or a server
 * or decoder string relabelled as safe. `message` is our own wording or a `ClientFailure.message`,
 * which the shared client already guarantees carries no credential, body, or decoder text.
 */
export interface AttemptOutcome {
  /** What happened to the request. */
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

/** The saved server answer, kept whole so a recovered success reports what was actually created. */
export interface AcknowledgedResult {
  readonly type: ContainerType;
  readonly id: number;
  readonly title: string;
}

export interface AttemptRecord {
  /** This device's durable identity for the attempt. Navigation refers to attempts by this. */
  readonly attemptId: string;
  /** The connection the request was made under. Never rewritten onto another one. */
  readonly connectionId: string;
  /**
   * A non-secret snapshot of where it was sent, so a record whose connection is gone can still say
   * what it belongs to. Identification only: it is never matched against a current connection to
   * infer that they are the same server.
   */
  readonly endpoint: string;
  readonly state: AttemptState;
  /** The frozen normalized request, as JSON text. */
  readonly request: string;
  /**
   * The submitted title, type, and parent, stored beside the request rather than read out of it.
   *
   * Deliberate duplication. These are the person's own input, written once and never updated, and a
   * recovery list has to be able to name an attempt even when the stored request no longer decodes -
   * which is exactly the case where reading it out of the request would fail.
   */
  readonly type: ContainerType;
  readonly title: string;
  readonly parentAreaId: number | null;
  /** Wall clock at first dispatch. Never reset by a retry, a recovery, or an acknowledgement. */
  readonly firstDispatchAt: number;
  readonly firstUncertainAt: number | null;
  /** True once time has been observed moving backwards for this attempt. Never cleared. */
  readonly clockAnomaly: boolean;
  readonly lastOutcome: AttemptOutcome | null;
  readonly acknowledged: AcknowledgedResult | null;
  /**
   * The highest wall-clock time this attempt has been seen at, not merely its last write.
   *
   * It only ever moves forward. A transition recorded while the clock is behind this value leaves it
   * alone, because the point of the field is to be the mark that later time is compared against: a
   * clock set back an hour is invisible against the first dispatch and obvious against this.
   */
  readonly observedAt: number;
}

/**
 * What an attempt means, as opposed to where it has got to.
 *
 * One helper answers this, and screens call it rather than reading `state`. The pairs that differ
 * only by history - a blocked attempt that was once uncertain, and one that never was - are the
 * whole reason it exists, and inferring them from the state string at six call sites is how one of
 * them eventually gets it wrong.
 */
export type LogicalState =
  /** Known not to have created anything. Correcting the input is possible. */
  | 'refused'
  /** It may or may not exist. The input stays frozen. */
  | 'unresolved'
  /** Known server success, waiting to be shown or dismissed. */
  | 'created';
