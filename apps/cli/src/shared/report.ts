/**
 * Turning a client failure into something a person can act on, without overclaiming.
 *
 * The governing rule: **recovery wording is built from the client's `mutationOutcome`, never from the
 * server's prose.** The server's generic `storage_busy` message reads "The request was not applied;
 * try again" - which is the server's claim about its own transaction, not a statement this client can
 * verify about the whole HTTP exchange. When the classification says `unknown`, the wording says
 * unknown, whatever the message beside it says.
 *
 * The second rule: an uncertain creation reports its idempotency key and when this attempt was
 * dispatched, and does so without echoing any content. Enough to find the work again; nothing that
 * puts a title or a body into a terminal log.
 */

import type { ClientFailure } from '@raphael/client';
import type { RecoveryDetails } from '@raphael/contracts';

import { EXIT_FAILURE, EXIT_USAGE, type ExitCode } from './exit.ts';
import { forTerminal, writeLine, type Streams } from './output.ts';

export interface AttemptContext {
  /** Present for creations. The key this invocation used. */
  readonly idempotencyKey?: string;
  /** When this invocation handed the request to the network. */
  readonly dispatchedAt?: Date;
  /**
   * Whether the key was supplied by the caller rather than generated here.
   *
   * This changes what may honestly be said about timing. `dispatchedAt` is when *this* invocation
   * sent something; for a reused key that is not when the original attempt was made, and the server's
   * 72-hour replay window runs from the original. Reporting this invocation's clock as though it
   * started the window would tell someone they have three days left when they may have none.
   */
  readonly keyWasSupplied?: boolean;
}

/**
 * The stable machine shape of a failure. Field names do not change without a deliberate decision,
 * because scripts read them.
 *
 * Never present: the response body, decoder messages, cause chains, the endpoint's credential, or any
 * authored content from the request.
 */
export interface FailureReport {
  readonly kind: string;
  readonly mutationOutcome: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly details?: RecoveryDetails | { readonly field: string };
  readonly idempotencyKey?: string;
  readonly dispatchedAt?: string;
  readonly keyWasSupplied?: boolean;
}

export const buildFailureReport = (
  failure: ClientFailure,
  context: AttemptContext = {},
): FailureReport => {
  // Assembled mutably, published immutably: the report is a value scripts read, and the fields it
  // carries depend on which failure this is.
  const base: { -readonly [K in keyof FailureReport]: FailureReport[K] } = {
    kind: failure.kind,
    mutationOutcome: failure.mutationOutcome,
    message: failure.message,
  };

  if (failure.kind === 'api_error') {
    base.code = failure.error.code;
    base.status = failure.status;
    if (Object.keys(failure.details).length > 0) base.details = failure.details;
  }
  if (failure.kind === 'invalid_response') {
    base.reason = failure.reason;
    if (failure.status !== undefined) base.status = failure.status;
  }
  if (failure.kind === 'invalid_request' && failure.path.length > 0) {
    base.details = { field: failure.path.join('.') };
  }

  // Only reported when the outcome is genuinely open. A rejected creation needs no key: nothing was
  // made, and printing one would suggest there is something to resolve.
  if (failure.mutationOutcome === 'unknown' && context.idempotencyKey !== undefined) {
    base.idempotencyKey = context.idempotencyKey;
    if (context.dispatchedAt !== undefined) base.dispatchedAt = context.dispatchedAt.toISOString();
    if (context.keyWasSupplied !== undefined) base.keyWasSupplied = context.keyWasSupplied;
  }

  return base;
};

/** Human-readable detail lines, each value escaped before it reaches a terminal. */
const detailLines = (details: object): string[] =>
  Object.entries(details).map(
    ([key, value]) =>
      `  ${key}: ${forTerminal(typeof value === 'string' ? value : JSON.stringify(value))}`,
  );

/**
 * Recovery guidance, chosen by outcome.
 *
 * Deliberately non-assertive for `unknown`: it says what could not be established and what to do, and
 * it does not say the work failed. "Check the destination" is the honest instruction, because it is
 * the only thing that actually settles the question.
 */
const guidanceFor = (failure: ClientFailure, context: AttemptContext): string[] => {
  if (failure.mutationOutcome !== 'unknown') return [];

  const lines = ['', 'Could not confirm whether this was created.'];
  if (failure.kind === 'transport') {
    lines.push('Check the server address and that the server is running.');
  }
  if (context.idempotencyKey !== undefined) {
    lines.push(
      '',
      'To retry safely, send the identical request with the same idempotency key:',
      `  --idempotency-key ${forTerminal(context.idempotencyKey)}`,
    );
    if (context.dispatchedAt !== undefined) {
      lines.push(
        context.keyWasSupplied === true
          ? `This invocation was sent at ${context.dispatchedAt.toISOString()}. That is not when the key was first used, and the server's replay window runs from the first use.`
          : `Sent at ${context.dispatchedAt.toISOString()}.`,
      );
    }
    lines.push(
      "The server's replay window is limited. Once it passes, a repeat may be refused as a duplicate address " +
        'or may create a second entity, so check the destination rather than retrying indefinitely.',
    );
  }
  return lines;
};

/** Write a failure in the readable form, to stderr, and return the exit code it implies. */
export const reportFailure = (
  streams: Streams,
  failure: ClientFailure,
  context: AttemptContext = {},
): ExitCode => {
  const report = buildFailureReport(failure, context);

  writeLine(streams.err, forTerminal(report.message));
  if (report.code !== undefined) {
    writeLine(
      streams.err,
      `  code: ${report.code}${report.status === undefined ? '' : ` (${report.status})`}`,
    );
  }
  if (report.reason !== undefined) writeLine(streams.err, `  reason: ${report.reason}`);
  if (report.details !== undefined) {
    for (const line of detailLines(report.details)) writeLine(streams.err, line);
  }
  for (const line of guidanceFor(failure, context)) writeLine(streams.err, line);

  // A request that never left is a usage problem the caller can fix locally; everything else is an
  // operation that did not succeed.
  return failure.kind === 'invalid_request' ? EXIT_USAGE : EXIT_FAILURE;
};
