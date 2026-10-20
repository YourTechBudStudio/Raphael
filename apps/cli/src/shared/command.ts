/**
 * What every command is handed, and what the renderers need to know about the run.
 *
 * An `Invocation` is fixed before a command starts: which command, whether `--json` was asked for,
 * and whether a success would change stored state. A `Session` adds what is learned while the command
 * runs - the endpoint, whether a write has gone out - so a failure raised anywhere, even one thrown
 * past the command, can still say honestly what happened.
 */

import type { OperationCall, Transport } from '@raphael/client';

import type { Interruption, InterruptSignal } from './interrupt.ts';
import type { Streams } from './output.ts';

export interface Invocation {
  /** The command as typed (`create`, `server serve`), or null when none was recognized. */
  readonly command: string | null;
  readonly json: boolean;
  /** Whether a success would change stored state. Decides whether a failure carries a state line. */
  readonly writes: boolean;
}

export interface Session {
  readonly invocation: Invocation;
  /** Set once a transport exists. */
  endpoint: string | undefined;
  /** Set when a write request is handed to the transport; from then on its outcome may be unknown. */
  writeSent: boolean;
  /** Set when a remote command watches signals. */
  interruption: Interruption | undefined;
}

export const newSession = (invocation: Invocation): Session => ({
  invocation,
  endpoint: undefined,
  writeSent: false,
  interruption: undefined,
});

export interface CommandContext {
  readonly streams: Streams;
  readonly session: Session;
  /** Cancelled by SIGINT or SIGTERM. Every request and every wait on input takes it. */
  readonly signal: AbortSignal;
  /**
   * The transport for this command. Called only once arguments are parsed, so argument errors are
   * reported before a credential is read. The same transport on every call.
   */
  readonly transport: () => Transport;
}

/** The signal that interrupted this session, if one did. */
export const interruptedBy = (session: Session): InterruptSignal | undefined =>
  session.interruption?.received();

/**
 * Wrap a transport so the session learns where it points and when a write leaves. Nothing about the
 * request is changed; this only observes.
 */
export const observedTransport = (session: Session, transport: Transport): Transport => {
  session.endpoint = transport.endpoint.base;
  return {
    endpoint: transport.endpoint,
    timeoutMs: transport.timeoutMs,
    invoke: <A>(call: OperationCall<A>) => {
      if (call.effect === 'write') session.writeSent = true;
      return transport.invoke(call);
    },
  };
};
