/**
 * What every command is handed, and what the renderers need to know about the run.
 *
 * An `Invocation` is fixed before a command starts: which command, whether `--json` was asked for,
 * and whether a success would change stored state. A `Session` adds what is learned while the command
 * runs - the endpoint, whether a write has gone out - so a failure raised anywhere, even one thrown
 * past the command, can still say honestly what happened.
 */

import type { OperationCall, Transport } from '@raphael/client';

import type { OptionConfig } from './args.ts';
import type { Interruption, InterruptSignal } from './interrupt.ts';
import type { Streams } from './output.ts';

export interface Invocation {
  /** The command as typed (`create`, `server serve`), or null when none was recognized. */
  readonly command: string | null;
  readonly json: boolean;
  /** Whether a success would change stored state. Decides whether a failure carries a state line. */
  readonly writes: boolean;
  readonly fieldFlags?: Readonly<Record<string, string>>;
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

/** A runnable example; argv excludes the executable name. */
export interface CommandExample {
  readonly argv: readonly string[];
  readonly description?: string;
}

export interface CommandOption {
  readonly name: string;
  readonly short?: string;
  readonly type: 'string' | 'boolean';
  readonly multiple?: boolean;
  readonly valueName?: string;
  readonly default?: string | number | boolean;
  readonly description: string;
  readonly constraint?: string;
  readonly changes?: boolean;
}

/** Product data owned beside a command's handler. Dispatch stays explicit. */
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly group: 'Read' | 'Write' | 'Setup';
  readonly writes: boolean;
  readonly usage: readonly string[];
  readonly behavior: readonly string[];
  readonly constraints?: readonly string[];
  readonly options: readonly CommandOption[];
  readonly examples: readonly CommandExample[];
  readonly prints: string;
  readonly next: string;
  readonly seeAlso?: readonly string[];
  readonly fieldFlags: Readonly<Record<string, string>>;
}

/** Parser grammar derives from the same options the help renderer describes. */
export const optionsFor = (definition: CommandDefinition): OptionConfig =>
  Object.fromEntries(
    definition.options.map(({ name, type, multiple, short }) => [
      name,
      {
        type,
        ...(multiple === undefined ? {} : { multiple }),
        ...(short === undefined ? {} : { short }),
      },
    ]),
  );
