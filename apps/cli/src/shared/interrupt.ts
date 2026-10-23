/**
 * Ctrl-C and SIGTERM during a remote command.
 *
 * Without a handler Node dies on the spot and the caller learns nothing, not even whether a write
 * had already gone out. With one, the signal cancels whatever the command is waiting on - a request,
 * or standard input - and the command ends through the failure renderer like any other failure, which
 * says whether the change was sent and exits 130 or 143.
 */

import { EXIT_SIGINT, EXIT_SIGTERM, type ExitCode } from './exit.ts';

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

export const exitCodeForSignal = (signal: InterruptSignal): ExitCode =>
  signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM;

/** Thrown where a signal ends a wait that is not a request, such as reading standard input. */
export class Interrupted extends Error {
  readonly signal: InterruptSignal;
  constructor(signal: InterruptSignal) {
    super(`Interrupted by ${signal}.`);
    this.name = 'Interrupted';
    this.signal = signal;
  }
}

export interface Interruption {
  /** Aborted by the first signal. Handed to every request and wait the command makes. */
  readonly signal: AbortSignal;
  /** The signal that arrived, if one did. */
  readonly received: () => InterruptSignal | undefined;
  /** Remove the handlers. Called once the command has its outcome. */
  readonly release: () => void;
}

/**
 * Watch for SIGINT and SIGTERM. The first cancels everything the command waits on; a second means the
 * person is not willing to wait for that, and `forceExit` ends the process at once.
 */
export const watchSignals = (
  onSignal: (signal: InterruptSignal, handler: () => void) => () => void,
  forceExit: (signal: InterruptSignal) => void,
): Interruption => {
  const controller = new AbortController();
  let received: InterruptSignal | undefined;
  const removers = (['SIGINT', 'SIGTERM'] as const).map((signal) =>
    onSignal(signal, () => {
      if (received !== undefined) {
        forceExit(signal);
        return;
      }
      received = signal;
      // The reason names the signal, so a wait that ends on it can say which one.
      controller.abort(signal);
    }),
  );
  return {
    signal: controller.signal,
    received: () => received,
    release: () => {
      for (const remove of removers) remove();
    },
  };
};

/** Throw `Interrupted` if a signal has already arrived, so nothing new starts after one. */
export const throwIfInterrupted = (interruption: Pick<Interruption, 'received'>): void => {
  const signal = interruption.received();
  if (signal !== undefined) throw new Interrupted(signal);
};

/**
 * Someone stopped answering a prompt: Ctrl-C or Ctrl-D at a question. Nothing was sent. Not a usage
 * mistake, so it carries no pointer to help; it exits 2 like any request that was not applied.
 */
export class Cancelled extends Error {
  /** The command to run to start again. */
  readonly retry: string;
  constructor(message: string, retry: string) {
    super(message);
    this.name = 'Cancelled';
    this.retry = retry;
  }
}
