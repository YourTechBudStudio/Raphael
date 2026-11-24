/**
 * The one failure renderer.
 *
 * Every failure - a mistyped flag, a missing login, a refusal from the server, a connection that
 * dropped mid-write - is described as a `Failure` and written here, in one of two forms:
 *
 * ```text
 * <what is wrong, naming what the caller typed>
 * <for a command that changes something: whether the change was sent, refused, or may have been
 *  applied, or what was left unchanged>
 * hint: <one next step>
 * code: <server code> (<status>)        only when the server answered
 * ```
 *
 * or, with `--json`, one error document on stderr and nothing on stdout. The exit code is chosen
 * here and nowhere else, from the table in `exit.ts`.
 *
 * The rule this module exists to keep: once a write has been sent, a failure never claims it did not
 * happen. `state` is `unknown` whenever the request may have reached the server without a definite
 * answer coming back, and the text and the document then both say so.
 */

import type { ClientFailure } from '@raphael/client';
import { API_ERROR_CODES, type ApiErrorCode, type ApiErrorDetails } from '@raphael/contracts';

import { version } from '../distribution.ts';
import type { Session } from './command.ts';
import { serverCode, type ErrorCode } from './error-codes.ts';
import {
  EXIT_FAILURE,
  EXIT_NOT_CONFIGURED,
  EXIT_RETRYABLE,
  EXIT_UNKNOWN,
  EXIT_USAGE,
  SERVER_CODE_EXIT,
  categoryOf,
  type ExitCode,
} from './exit.ts';
import { clientFailureWording } from './failure-wording.ts';
import { exitCodeForSignal, type InterruptSignal } from './interrupt.ts';
import { forTerminal, writeJson, writeLine, type Streams } from './output.ts';
import { PROTOCOL_VERSION, type Diagnosis } from './server-check.ts';

/** How the caller named an item: by path, or by `--id`. */
export type Subject = { readonly path: string } | { readonly id: number };

/**
 * What a command knows about the request that failed, so the failure can name what was typed
 * rather than what the server saw. Every member is optional; a sentence uses what it has.
 */
export interface RequestContext {
  /** The item the command acts on, as typed. For a path-form create, the full new path. */
  readonly subject?: Subject;
  /** Where a create puts the new item. */
  readonly parent?: Subject;
  /** The slug a create or an update writes. */
  readonly slug?: string;
  /** A move's destination, as typed. */
  readonly destination?: string;
  /** A page request's scopes, in the order they were sent. */
  readonly scopes?: readonly Subject[];
  /** The revision sent, whether the caller gave it, and whether the command could do without it. */
  readonly revision?: {
    readonly sent: number;
    readonly given: boolean;
    readonly required: boolean;
  };
  /** How the caller spelled each request field, where it is not `--<field>`. */
  readonly flags?: Readonly<Partial<Record<string, string>>>;
  /** A command that shows whether a write landed. */
  readonly check?: string;
  /** A command to run next with what `check` printed, when one alone cannot show it. */
  readonly checkThen?: string;
  /** Where to look instead when the write would have landed elsewhere, and when that is. */
  readonly checkOtherwise?: { readonly when: string; readonly check: string };
  /** The failing request was the read made before the change, so the change was never sent. */
  readonly beforeChange?: boolean;
}

/** How far a change got. Only printed for a command that writes. */
export type ChangeState = 'not_sent' | 'refused' | 'unknown';

export interface Failure {
  /** The server's code when it answered with one; otherwise this CLI's own, from `CLI_ERROR_CODES`. */
  readonly code: ErrorCode;
  readonly exitCode: Exclude<ExitCode, 0>;
  readonly message: string;
  readonly hint: string;
  readonly state: ChangeState;
  readonly status?: number;
  /** The flag or argument concerned, as the caller would type it. */
  readonly field?: string;
  readonly target?: Subject;
  readonly serverMessage?: string;
  readonly details?: FailureDetails;
  /** Server answers carry a `code:` line in text. */
  readonly fromServer: boolean;
  /**
   * What this failure left unchanged, for a command that changes something other than stored items
   * and can say so for this failure only: serve's `Nothing was created.` for a port it could not bind.
   */
  readonly stateLine?: string;
  /** What the system said, printed after the layout only with `RAPHAEL_DEBUG=1`, never in JSON. */
  readonly debug?: string;
}

const STATE_LINES: Readonly<Record<ChangeState, string>> = {
  not_sent: 'The change was not sent.',
  refused: 'Nothing was changed.',
  unknown: 'The change may or may not have been applied.',
};

/** Write a failure in the form the caller asked for, and return its exit code. */
export const renderFailure = (streams: Streams, session: Session, failure: Failure): ExitCode => {
  const { invocation } = session;
  if (invocation.json) {
    writeJson(streams.err, {
      ok: false,
      command: invocation.command,
      error: {
        code: failure.code,
        category: categoryOf(failure.exitCode),
        message: failure.message,
        hint: failure.hint,
        exitCode: failure.exitCode,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.field === undefined ? {} : { field: failure.field }),
        ...(failure.target === undefined ? {} : { target: failure.target }),
        // A read applies nothing, whatever happened to it.
        applied: !invocation.writes ? false : failure.state === 'unknown' ? null : false,
        retryable: failure.exitCode === EXIT_RETRYABLE,
        ...(failure.serverMessage === undefined ? {} : { serverMessage: failure.serverMessage }),
        ...(failure.details === undefined ? {} : { details: failure.details }),
        // Which server and which source, once a connection was resolved: the same shape as
        // `status --json`, so an agent can tell "fix the environment" from "log in again".
        ...(session.connection === undefined ? {} : { connection: session.connection }),
      },
    });
    return failure.exitCode;
  }

  writeLine(streams.err, failure.message);
  const stateLine = invocation.writes
    ? STATE_LINES[failure.state]
    : (failure.stateLine ?? invocation.stateLine);
  if (stateLine !== undefined) writeLine(streams.err, stateLine);
  writeLine(streams.err, `hint: ${failure.hint}`);
  if (failure.fromServer) {
    const status = failure.status === undefined ? '' : ` (${failure.status})`;
    writeLine(streams.err, `code: ${forTerminal(failure.code)}${status}`);
  }
  if (session.debug && failure.debug !== undefined) {
    writeLine(streams.err, `debug: ${forTerminal(failure.debug)}`);
  }
  return failure.exitCode;
};

const ADDRESS_CAUSES: ReadonlySet<NonNullable<ClientFailure['cause']>> = new Set([
  'tls',
  'certificate',
  'blocked_port',
  'not_http',
]);

const isKnownCode = (code: string): code is ApiErrorCode =>
  (API_ERROR_CODES as readonly string[]).includes(code);

const isSuccessStatus = (status: number | undefined): boolean =>
  status !== undefined && status >= 200 && status < 300;

/**
 * Exit code and change state, from what the client reports about how far the request got.
 *
 * `failure.effect` is about the request that failed. A command that writes may fail on the read it
 * makes first; that read's failure exits as a read, and the change it was preparing was not sent.
 */
const classify = (
  failure: ClientFailure,
  context: RequestContext,
  signal: InterruptSignal | undefined,
  diagnosis: Diagnosis | undefined,
): { readonly exitCode: Exclude<ExitCode, 0>; readonly state: ChangeState } => {
  const base = classifyAnswer(failure, context, signal);
  // Once verification has shown the endpoint speaks another protocol or is not Raphael, a failure
  // that left nothing uncertain is a setup problem. A write that may have landed stays unknown.
  return diagnosis !== undefined && base.state !== 'unknown'
    ? { exitCode: EXIT_NOT_CONFIGURED, state: base.state }
    : base;
};

const classifyAnswer = (
  failure: ClientFailure,
  context: RequestContext,
  signal: InterruptSignal | undefined,
): { readonly exitCode: Exclude<ExitCode, 0>; readonly state: ChangeState } => {
  const write = failure.effect === 'write' && context.beforeChange !== true;
  // Could the server have applied it? Only a write that may have arrived without an answer.
  const unknownIfWrite = (
    readCode: Exclude<ExitCode, 0>,
  ): { readonly exitCode: Exclude<ExitCode, 0>; readonly state: ChangeState } =>
    write
      ? { exitCode: EXIT_UNKNOWN, state: 'unknown' as const }
      : { exitCode: readCode, state: 'not_sent' as const };
  const sentState: ChangeState = context.beforeChange === true ? 'not_sent' : 'refused';
  // An answer that did not come from Raphael itself - a redirect, a bare status - says nothing about
  // whether something in front of the server forwarded the write first, so a sent write is unknown.
  const unvouchedState: ChangeState = write ? 'unknown' : sentState;

  switch (failure.kind) {
    case 'invalid_request':
      return { exitCode: EXIT_USAGE, state: 'not_sent' };
    case 'cancelled': {
      const exitCode = signal === undefined ? EXIT_FAILURE : exitCodeForSignal(signal);
      return {
        exitCode: exitCode as Exclude<ExitCode, 0>,
        state: write && failure.delivery !== 'not_sent' ? 'unknown' : 'not_sent',
      };
    }
    case 'network':
      // Some causes are address problems that retrying will not change: a TLS handshake that failed
      // (https to an http server), a certificate this machine does not trust, a port fetch refuses to
      // use, or an answer that is not HTTP at all. A write that may have gone out still stays unknown.
      if (failure.cause !== undefined && ADDRESS_CAUSES.has(failure.cause)) {
        return failure.delivery === 'not_sent'
          ? { exitCode: EXIT_NOT_CONFIGURED, state: 'not_sent' }
          : unknownIfWrite(EXIT_NOT_CONFIGURED);
      }
      if (failure.delivery === 'not_sent') return { exitCode: EXIT_RETRYABLE, state: 'not_sent' };
      return unknownIfWrite(EXIT_RETRYABLE);
    case 'timeout':
      if (failure.delivery === 'not_sent') return { exitCode: EXIT_RETRYABLE, state: 'not_sent' };
      return unknownIfWrite(EXIT_RETRYABLE);
    case 'bad_response':
      // An answer on a success status that could not be read: the server took the request.
      if (isSuccessStatus(failure.status)) return unknownIfWrite(EXIT_FAILURE);
      return { exitCode: EXIT_NOT_CONFIGURED, state: unvouchedState };
    case 'http': {
      if (failure.code !== undefined && isKnownCode(failure.code)) {
        const mapped = SERVER_CODE_EXIT[failure.code];
        if (mapped === 'server_fault') return unknownIfWrite(EXIT_FAILURE);
        return { exitCode: mapped as Exclude<ExitCode, 0>, state: sentState };
      }
      // No Raphael code we know: a proxy's page, or a newer server's code. A server-side fault on a
      // write may still have applied it.
      if ((failure.status ?? 0) >= 500) return unknownIfWrite(EXIT_FAILURE);
      // A newer server's code is Raphael's own refusal; a bare status is not.
      return failure.code === undefined
        ? { exitCode: EXIT_NOT_CONFIGURED, state: unvouchedState }
        : { exitCode: EXIT_FAILURE, state: sentState };
    }
  }
};

/** Describe a client failure for this session, naming what the caller typed. */
export const describeClientFailure = (
  session: Session,
  failure: ClientFailure,
  context: RequestContext = {},
): Failure => {
  const signal = session.interruption?.received();
  const { exitCode, state } = classify(failure, context, signal, session.diagnosis);
  const worded = clientFailureWording(failure, {
    context: { ...context, flags: { ...session.invocation.fieldFlags, ...context.flags } },
    endpoint: session.endpoint,
    connection: session.connection,
    diagnosis: session.diagnosis,
    command: session.invocation.command,
    state,
    signal,
  });
  // A diagnosed protocol mismatch is one condition however the newer server answered, so it has one
  // code; the server's own code and status stay as facts in the document, not as the code.
  const mismatch = worded.code === 'incompatible_protocol';
  const answered = failure.kind === 'http' && failure.code !== undefined && !mismatch;
  const target = worded.target ?? context.subject;
  const details: FailureDetails | undefined = mismatch
    ? mismatchDetails(session.diagnosis, failure)
    : failure.details;
  return {
    // A server's answer keeps the server's code; the CLI's own codes name what happened locally.
    code: answered && failure.code !== undefined ? serverCode(failure.code) : worded.code,
    exitCode,
    message: worded.message,
    hint: worded.hint,
    state,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(worded.field === undefined ? {} : { field: worded.field }),
    ...(target === undefined ? {} : { target }),
    ...(answered || (mismatch && failure.kind === 'http' && failure.code !== undefined)
      ? { serverMessage: failure.message }
      : {}),
    ...(details === undefined ? {} : { details }),
    ...(failure.diagnostic === undefined ? {} : { debug: failure.diagnostic }),
    fromServer: answered,
  };
};

/**
 * Both sides of a protocol mismatch, each null when unknown, and the server's own code when the
 * request that failed was answered with one.
 */
export interface ProtocolMismatchDetails {
  /** As the server sent it: a date, or the number an early server used. */
  readonly serverProtocol: string | number | null;
  readonly serverVersion: string | null;
  readonly cliProtocol: string;
  readonly cliVersion: string;
  readonly serverCode?: string;
}

export type FailureDetails = ApiErrorDetails | ProtocolMismatchDetails;

const mismatchDetails = (
  diagnosis: Diagnosis | undefined,
  failure: ClientFailure,
): ProtocolMismatchDetails => ({
  serverProtocol: diagnosis?.kind === 'incompatible' ? diagnosis.protocolVersion : null,
  serverVersion: diagnosis?.kind === 'incompatible' ? (diagnosis.raphaelVersion ?? null) : null,
  cliProtocol: PROTOCOL_VERSION,
  cliVersion: version(),
  ...(failure.kind === 'http' && failure.code !== undefined ? { serverCode: failure.code } : {}),
});

/** Describe and render a client failure in one step: what every command does with one. */
export const reportClientFailure = (
  streams: Streams,
  session: Session,
  failure: ClientFailure,
  context: RequestContext = {},
): ExitCode => renderFailure(streams, session, describeClientFailure(session, failure, context));
