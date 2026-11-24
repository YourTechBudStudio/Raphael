/**
 * What every command is handed, and what the renderers need to know about the run.
 *
 * An `Invocation` is fixed before a command starts: which command, whether `--json` was asked for,
 * and whether a success would change stored state. A `Session` adds what is learned while the command
 * runs - the endpoint, whether a write has gone out - so a failure raised anywhere, even one thrown
 * past the command, can still say honestly what happened.
 */

import type { OperationCall, Transport } from '@raphael/client';

import type { OptionConfig, OptionSpec, WholeRange } from './args.ts';
import type { Interruption, InterruptSignal } from './interrupt.ts';
import type { Streams } from './output.ts';
import { checkServer, diagnosisOf, isUnexplainedAnswer, type Diagnosis } from './server-check.ts';

/**
 * Which server a command is talking to, and why: the environment pair, or the saved login at its
 * file. The same shape is the `connection` member of `status --json` and of every error document
 * for a failure after the connection was resolved, so an agent reads one shape either way.
 */
export interface ConnectionInfo {
  readonly endpoint: string;
  readonly source: 'environment' | 'saved_login';
  /** The saved login's file; null when the connection came from the environment. */
  readonly configFile: string | null;
}

/** A transport, with what it is connected to. */
export interface Connected {
  readonly transport: Transport;
  readonly connection: ConnectionInfo;
}

export interface Invocation {
  /** The command as typed (`create`, `server serve`), or null when none was recognized. */
  readonly command: string | null;
  /** The arguments as typed, so a refusal can repeat the command with one of them corrected. */
  readonly argv?: readonly string[];
  readonly json: boolean;
  /** Whether a success would change stored state. Decides whether a failure carries a state line. */
  readonly writes: boolean;
  /**
   * For a command that changes something other than stored items, what every failure of it left
   * unchanged, printed as its state line: login's `Nothing was saved.`
   */
  readonly stateLine?: string;
  readonly fieldFlags?: Readonly<Record<string, string>>;
  /**
   * The command verifies the server itself (`status`, `login`), so an unreadable answer is never
   * followed by a second verification.
   */
  readonly verifiesItself?: boolean;
}

export interface Session {
  readonly invocation: Invocation;
  /** Set once a transport exists. */
  endpoint: string | undefined;
  /** Set once a resolved connection's transport exists. Login's typed address is not one. */
  connection: ConnectionInfo | undefined;
  /** What one verification said about an answer that could not be read. */
  diagnosis: Diagnosis | undefined;
  /** Set when a write request is handed to the transport; from then on its outcome may be unknown. */
  writeSent: boolean;
  /** Set when a remote command watches signals. */
  interruption: Interruption | undefined;
  /** `RAPHAEL_DEBUG=1`: failures add what the system said, after their layout. */
  readonly debug: boolean;
}

export const newSession = (invocation: Invocation, debug = false): Session => ({
  invocation,
  debug,
  endpoint: undefined,
  connection: undefined,
  diagnosis: undefined,
  writeSent: false,
  interruption: undefined,
});

/**
 * Whether standard input and standard output are terminals. A header row is printed only on a
 * terminal, and a body read from a terminal says how to finish. Not a terminal covers a pipe, a file,
 * `/dev/null` and a closed descriptor alike, so anything worded from it is worded conditionally.
 */
export interface Terminal {
  readonly stdin: boolean;
  readonly stdout: boolean;
}

export interface CommandContext {
  readonly streams: Streams;
  readonly session: Session;
  /** Cancelled by SIGINT or SIGTERM. Every request and every wait on input takes it. */
  readonly signal: AbortSignal;
  /** Which standard streams are terminals. Decided from `isTTY` alone; nothing is read to find out. */
  readonly terminal: Terminal;
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
 * request is changed.
 *
 * One thing is added. When an answer could not be read as Raphael's - an unreadable success, a
 * status with no Raphael error, a route the server does not have - the server is asked once, through
 * the same transport, what it is, so the failure can say "this server speaks another protocol" or
 * "this is not a Raphael server" instead of "could not read". That request shares the original's
 * abort signal and what is left of its timeout. Whatever it finds only refines the wording: the
 * original failure is what the command reports, and a failed verification changes nothing.
 * Commands that verify the server themselves never trigger it.
 */
export const observedTransport = (
  session: Session,
  transport: Transport,
  connection?: ConnectionInfo,
): Transport => {
  session.endpoint = transport.endpoint.base;
  if (connection !== undefined) session.connection = connection;
  let asked = false;

  const diagnose = async (signal: AbortSignal | undefined, startedAt: number): Promise<void> => {
    const remaining = transport.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0 || signal?.aborted === true) return;
    const bounded = AbortSignal.timeout(remaining);
    const check = await checkServer(
      transport,
      signal === undefined ? bounded : AbortSignal.any([signal, bounded]),
    );
    session.diagnosis = diagnosisOf(check);
  };

  return {
    endpoint: transport.endpoint,
    timeoutMs: transport.timeoutMs,
    invoke: async <A>(call: OperationCall<A>) => {
      if (call.effect === 'write') session.writeSent = true;
      const startedAt = Date.now();
      const result = await transport.invoke(call);
      if (
        !result.ok &&
        !asked &&
        session.invocation.verifiesItself !== true &&
        isUnexplainedAnswer(result.failure)
      ) {
        asked = true;
        await diagnose(call.signal, startedAt);
      }
      return result;
    },
  };
};

/** A runnable example; argv excludes the executable name. */
export interface CommandExample {
  readonly argv: readonly string[];
  readonly description?: string;
}

interface OptionBase {
  readonly name: string;
  readonly short?: string;
  readonly multiple?: boolean;
  readonly description: string;
  readonly constraint?: string;
  readonly changes?: boolean;
}

export interface FlagOption extends OptionBase {
  readonly type: 'boolean';
}

export interface ValueOption extends OptionBase {
  readonly type: 'string';
  /** The value is a whole number in this range; refusals state it. */
  readonly whole?: WholeRange;
  readonly valueName?: string;
  readonly default?: string | number | boolean;
  /** A value that works, shown when the value is missing: `For example: --port 3000.` */
  readonly example: string;
  /** No value starts with a dash, so the `--name=value` form for such values is never offered. */
  readonly leadingDash?: false;
}

export type CommandOption = FlagOption | ValueOption;

/**
 * The two options every command shares, worded once so they read the same on every page. What the
 * JSON document holds is each command's own `prints`.
 */
export const JSON_OPTION: CommandOption = {
  name: 'json',
  type: 'boolean',
  description: 'Print the result as one JSON document.',
};
export const HELP_OPTION: CommandOption = {
  name: 'help',
  short: 'h',
  type: 'boolean',
  description: 'Show help.',
};

/** Product data owned beside a command's handler. Dispatch stays explicit. */
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly group: 'Read' | 'Write' | 'Setup';
  readonly writes: boolean;
  /** The command verifies the server itself, so its unreadable answers are not verified again. */
  readonly verifiesServer?: boolean;
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
    definition.options.map((option): [string, OptionSpec] => {
      const shared = {
        ...(option.multiple === undefined ? {} : { multiple: option.multiple }),
        ...(option.short === undefined ? {} : { short: option.short }),
      };
      return [
        option.name,
        option.type === 'boolean'
          ? { type: 'boolean', ...shared }
          : {
              type: 'string',
              ...shared,
              example: option.example,
              ...(option.whole === undefined ? {} : { whole: option.whole }),
              ...(option.leadingDash === undefined ? {} : { leadingDash: option.leadingDash }),
            },
      ];
    }),
  );
