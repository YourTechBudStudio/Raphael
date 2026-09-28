/**
 * Turning a client failure into something a person can act on. The message is the server's own
 * sentence when there was one; the code and status follow it for scripts and for searching.
 */

import type { ClientFailure } from '@raphael/client';

import { EXIT_FAILURE, EXIT_USAGE, type ExitCode } from './exit.ts';
import { forTerminal, writeLine, type Streams } from './output.ts';

export interface AttemptContext {
  /**
   * Set when this failure happened while *preparing* a change - the convenience revision read - so
   * the change itself was never sent.
   */
  readonly beforeDispatch?: boolean;
}

const guidanceFor = (failure: ClientFailure, context: AttemptContext): string[] => {
  const sentences: string[] = [];
  if (context.beforeDispatch === true) sentences.push('The change was not sent.');
  if (failure.code === 'revision_conflict') {
    sentences.push('Re-read it, apply your change to the current version, and send it again.');
  }
  if (failure.kind === 'network') {
    sentences.push('Check the server address and that the server is running.');
  }
  return sentences.length === 0 ? [] : ['', ...sentences];
};

/** Write a failure in the readable form, to stderr, and return the exit code it implies. */
export const reportFailure = (
  streams: Streams,
  failure: ClientFailure,
  context: AttemptContext = {},
): ExitCode => {
  writeLine(streams.err, forTerminal(failure.message));
  if (failure.code !== undefined) {
    const status = failure.status === undefined ? '' : ` (${failure.status})`;
    writeLine(streams.err, `  code: ${forTerminal(failure.code)}${status}`);
  } else if (failure.status !== undefined) {
    writeLine(streams.err, `  status: ${failure.status}`);
  }
  for (const line of guidanceFor(failure, context)) writeLine(streams.err, line);

  // A request that never left is a usage problem the caller can fix locally; everything else is an
  // operation that did not succeed.
  return failure.kind === 'invalid_request' ? EXIT_USAGE : EXIT_FAILURE;
};
