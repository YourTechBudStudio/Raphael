import type { RouteDescriptor } from '@raphael/contracts';
import type { Effect } from 'effect';

import type { Db } from '../database/index.ts';
import type { TransportError } from './errors.ts';

/**
 * What a capability publishes to the transport, and the only thing the transport knows about it.
 *
 * A capability owns its own registration: the address, the label it is known by in a log, the status
 * a success carries, and - crucially - the translation of its own tagged failures into a public
 * error. The host never inspects a capability error, never maps a tag to a status, and never decides
 * what a failure means. It runs the effect, writes the result, and reports the outcome.
 *
 * `label` exists because a log must never contain a request path. A path is caller-controlled text
 * that can carry anything a body can; the label is our own word for a route we published.
 */

/**
 * Operator-facing context for a failure the caller is not told about. Sanitized, in our own words,
 * and never containing submitted content, a driver message, or a cause chain.
 */
export interface OperationDiagnostic {
  readonly stage: string;
  readonly detail: string;
}

/** A capability failure, already projected. The transport writes `error` and logs `diagnostic`. */
export interface OperationFailure {
  readonly error: TransportError;
  /** Present only for failures an operator needs to see. Expected outcomes carry none. */
  readonly diagnostic?: OperationDiagnostic;
}

export interface OperationRoute {
  readonly descriptor: RouteDescriptor;
  /** A fixed, caller-independent name for this route. The only route identity a log ever carries. */
  readonly label: string;
  /** 201 for a single-entity creation, including a replay; 200 for reads and verification. */
  readonly successStatus: 200 | 201;
  /**
   * Runs the operation against an undecoded body. The body is JSON that parsed; nothing has inspected
   * its shape, because the capability below owns the only decode.
   */
  readonly run: (body: unknown) => Effect.Effect<unknown, OperationFailure, Db>;
}
