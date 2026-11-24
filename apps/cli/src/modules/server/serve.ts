/**
 * `raphael server serve`: the local administration side of the one installed command.
 *
 * Two things make this different from every other command here.
 *
 * **The backend is loaded lazily, and only here.** `import('@raphael/backend')` brings in the HTTP
 * stack, Drizzle, and the SQLite driver's JavaScript; the driver's native binary itself is loaded later
 * still, when the first database is opened. Help, version, and every remote command must work without
 * any of that, on a machine where the native binary may not even load, so the import sits inside this
 * function rather than at the top of any module the dispatcher touches. Note what this does and does
 * not buy: it keeps the driver out of the *process*, not out of the *installation*.
 *
 * **This owns the process lifecycle.** The backend publishes a scoped resource and deliberately
 * registers no signal handler and never calls `process.exit` - it is a library, and a library that
 * grabbed SIGINT would be unusable inside anything else. So the entry point holds the scope open until
 * a signal arrives, then releases it and lets the documented shutdown run.
 *
 * A second signal escalates. Someone pressing Ctrl-C twice is telling us the graceful path is taking
 * too long, and the honest response is to stop - while saying plainly that cleanup did not finish,
 * because a forced exit leaves a database that was not closed in an orderly way.
 */

import { statSync } from 'node:fs';

import type { ConfigurationReason } from '@raphael/backend';
import { SENDABLE_API_KEY_RULE } from '@raphael/contracts/connection';
import { describeSystemError } from '@raphael/fs-trust';
import { Cause, Deferred, Effect, Exit, Option, Scope } from 'effect';

import { migrationsFolder, version } from '../../distribution.ts';
import { UsageError, integerOption, parseArgs, stringOption } from '../../shared/args.ts';
import {
  HELP_OPTION,
  optionsFor,
  type CommandDefinition,
  type Session,
} from '../../shared/command.ts';
import type { CliErrorCode } from '../../shared/error-codes.ts';
import {
  EXIT_FAILURE,
  EXIT_NOT_CONFIGURED,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_USAGE,
  type ExitCode,
} from '../../shared/exit.ts';
import { shellArg } from '../../shared/failure-wording.ts';
import { renderFailure, type Failure } from '../../shared/failure.ts';
import { exitCodeForSignal } from '../../shared/interrupt.ts';
import { forTerminal, writeLine, type Streams } from '../../shared/output.ts';
import { SERVE_DEFAULTS, SERVE_PORT_RANGE } from '../../shared/serve-defaults.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  SERVER_API_KEY_VARIABLE,
  SERVER_KEY_FILE_RECIPE,
} from '../../shared/variables.ts';

export { SERVE_DEFAULTS, SERVE_PORT_RANGE } from '../../shared/serve-defaults.ts';

export const SERVE_DEFINITION: CommandDefinition = {
  name: 'server serve',
  summary: 'Run a Raphael server on this machine.',
  group: 'Setup',
  writes: false,
  usage: [
    'raphael server serve [--config <path>] [--host <address>] [--port <n>] [--database <path>]',
  ],
  behavior: [
    `The API key comes from ${SERVER_API_KEY_VARIABLE}, in the environment or in a .env file. With --config, .env is read from that file's directory; without it, from the current directory.`,
    `Make an owner-only key file with: \`${SERVER_KEY_FILE_RECIPE}\`. Clients log in with the same key. It must be ${SENDABLE_API_KEY_RULE}. In .env, quote a key that contains #, which otherwise starts a comment.`,
    `Clients read ${CLIENT_API_KEY_VARIABLE}, not ${SERVER_API_KEY_VARIABLE}, so starting a server never changes which server client commands use.`,
    `Without --config, listens on ${SERVE_DEFAULTS.host}:${SERVE_DEFAULTS.port} with the database at ${SERVE_DEFAULTS.databasePath}, relative to the current directory.`,
    "The YAML file may set server.host, server.port and database.path; every key is optional and unknown keys are refused. A relative database.path resolves against the file's directory.",
    'Flags override the file. A relative --database resolves against the current directory.',
    'The port is bound before the database is opened, so a port in use creates nothing.',
    'This command never reads your saved login. It prints only to standard error and runs until Ctrl-C.',
    'A stop by signal finishes the shutdown, then exits 130 after Ctrl-C (SIGINT) or 143 after SIGTERM. A second signal stops it at once, without finishing.',
  ],
  options: [
    {
      name: 'config',
      type: 'string',
      valueName: 'path',
      description: 'Read configuration from this YAML file.',
      example: './raphael.yaml',
    },
    {
      name: 'host',
      type: 'string',
      valueName: 'address',
      default: SERVE_DEFAULTS.host,
      example: SERVE_DEFAULTS.host,
      leadingDash: false,
      description: 'Address to listen on. 0.0.0.0 listens on every interface.',
    },
    {
      name: 'port',
      type: 'string',
      valueName: 'n',
      default: String(SERVE_DEFAULTS.port),
      example: String(SERVE_DEFAULTS.port),
      whole: SERVE_PORT_RANGE,
      description: `Port to listen on, from ${SERVE_PORT_RANGE.min} to ${SERVE_PORT_RANGE.max}.`,
    },
    {
      name: 'database',
      type: 'string',
      valueName: 'path',
      default: SERVE_DEFAULTS.databasePath,
      example: SERVE_DEFAULTS.databasePath,
      description: 'SQLite database file. Created if it does not exist.',
    },
    HELP_OPTION,
  ],
  examples: [
    { argv: ['server', 'serve'] },
    { argv: ['server', 'serve', '--port', '3100'] },
    { argv: ['server', 'serve', '--config', './raphael.yaml'] },
    { argv: ['server', 'serve', '--host', '0.0.0.0', '--database', './data/raphael.sqlite'] },
  ],
  prints:
    'The address, the database, where the key came from, and the login command, on standard error. Standard output is empty.',
  next: 'raphael login http://127.0.0.1:3000',
  seeAlso: ['connecting'],
  fieldFlags: { config: '--config', host: '--host', port: '--port', database: '--database' },
};

export const SERVER_DEFINITION: CommandDefinition = {
  name: 'server',
  summary: 'Manage the server on this machine.',
  group: 'Setup',
  writes: false,
  usage: ['raphael server <subcommand> [options]'],
  behavior: ['Use `raphael server serve` to run the server.'],
  options: [HELP_OPTION],
  examples: [
    { argv: ['server', 'serve', '--help'] },
    { argv: ['help', 'server', 'serve'] },
    { argv: ['help', 'connecting'] },
  ],
  prints: 'Help for local server commands.',
  next: 'raphael server serve --help',
  fieldFlags: {},
};

export interface ServeDependencies {
  readonly streams: Streams;
  readonly session: Session;
  /** Registers a handler and returns a function that removes it. Tests supply their own. */
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  /** Forced termination. Separated so a test can observe it instead of dying. */
  readonly exit: (code: ExitCode) => void;
  readonly cwd: string;
  /** Print the cause chain of a startup failure (`RAPHAEL_DEBUG=1`). */
  readonly debug?: boolean;
}

/** Loaded lazily so that nothing else in this process pays for the native driver. */
const loadBackend = async (): Promise<typeof import('@raphael/backend')> =>
  import('@raphael/backend');

export interface ServeArguments {
  readonly configPath?: string;
  readonly overrides: {
    readonly host?: string;
    readonly port?: number;
    readonly databasePath?: string;
  };
}

/**
 * Parse without loading the backend or starting a listener. The port is checked here, by the rule every
 * whole-number flag follows; the other values are checked by the backend.
 */
export const parseServeArgs = (argv: readonly string[]): ServeArguments => {
  const parsed = parseArgs(argv, optionsFor(SERVE_DEFINITION), 'server serve');
  if (parsed.positionals.length > 0) {
    throw new UsageError('server serve takes no arguments.', 'server serve');
  }
  const configPath = stringOption(parsed, 'config');
  const host = stringOption(parsed, 'host');
  // The shared whole-number rule, so --port is refused in the same sentence as --limit, and only
  // digits are accepted: 3000.0 and 1e3 are not ports.
  const port = integerOption(parsed, 'port', 'server serve');
  const databasePath = stringOption(parsed, 'database');
  return {
    ...(configPath === undefined ? {} : { configPath }),
    overrides: {
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      ...(databasePath === undefined ? {} : { databasePath }),
    },
  };
};

/** Multi-line operator text, each line escaped on its own. */
const escapedLines = (text: string): string => text.split('\n').map(forTerminal).join('\n');

/** Where a URL for this address points: brackets for IPv6, loopback for an any-address. */
const loginAddress = (host: string, port: number): string => {
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return reachable.includes(':') ? `http://[${reachable}]:${port}` : `http://${reachable}:${port}`;
};

interface StartupDetails {
  readonly stage: 'listen' | 'database';
  readonly code: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly cause: unknown;
}

/** One sentence and one next step for a server that did not start. */
export const startupFailure = (details: StartupDetails): Failure => {
  const { host, port, databasePath, code } = details;
  const at = `${forTerminal(host)}:${port}`;
  const database = `"${forTerminal(databasePath)}"`;
  const failure = (
    failureCode: CliErrorCode,
    message: string,
    hint: string,
    exitCode: Failure['exitCode'] = EXIT_NOT_CONFIGURED,
  ): Failure => ({
    code: failureCode,
    exitCode,
    message,
    hint,
    state: 'not_sent',
    fromServer: false,
  });

  if (details.stage === 'listen') {
    // The port is bound before the database is opened, so a listener that failed created nothing.
    const notListening = (...args: Parameters<typeof failure>): Failure => ({
      ...failure(...args),
      stateLine: 'Nothing was created.',
    });
    switch (code) {
      case 'EADDRINUSE':
        return notListening(
          'port_in_use',
          `Port ${port} on ${forTerminal(host)} is already in use.`,
          'Stop whatever is using it, or choose another port with --port or server.port.',
        );
      case 'EACCES':
      case 'EPERM':
        return notListening(
          'listen_denied',
          `Cannot listen on ${at}: permission denied.`,
          'Ports below 1024 need elevated privileges; choose a higher port with --port or server.port.',
        );
      case 'EADDRNOTAVAIL':
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
      case 'EAI_FAIL':
      case 'EAI_NONAME':
        return notListening(
          'host_unavailable',
          `${forTerminal(host)} is not an address on this machine.`,
          'Use 127.0.0.1, or an address this machine has, with --host or server.host.',
        );
      default:
        return notListening(
          'listen_failed',
          `Cannot listen on ${at}: ${causeMessage(details.cause)}`,
          'Choose another address with --host and --port, or fix the configuration.',
          EXIT_FAILURE,
        );
    }
  }
  // SQLite's extended codes (SQLITE_CANTOPEN_ISDIR, SQLITE_CORRUPT_INDEX) are read as their family.
  switch (code?.match(/^SQLITE_[A-Z]+/u)?.[0] ?? code) {
    case 'database_in_use':
      return failure(
        'database_in_use',
        `The database at ${database} is already in use by another process, such as another Raphael server.`,
        'Stop the other process, or use another database with --database or database.path.',
      );
    case 'migration_history':
      return failure(
        'database_newer',
        `The database at ${database} was migrated by a newer or different Raphael release.`,
        'Update raphael, or use another database with --database or database.path.',
      );
    case 'EEXIST':
    case 'ENOTDIR':
      // Creating the database's directory met a file where a directory should be.
      return failure(
        'database_unusable',
        `Cannot open the database at ${database}: part of the path is not a directory.`,
        'Set --database or database.path to a file path you can write.',
      );
    case 'ENOENT':
      // Creating the database's directory found no parent to create it in: a folder that does not
      // exist where it cannot be made, or a link to nowhere.
      return failure(
        'database_unusable',
        `Cannot open the database at ${database}: part of the path does not exist and could not be created.`,
        'Set --database or database.path to a file path you can write.',
      );
    case 'EACCES':
    case 'EPERM':
    case 'EISDIR':
    case 'EROFS':
    case 'ENOSPC':
      return failure(
        'database_unusable',
        `Cannot open the database at ${database}: ${describeSystemError(details.cause)}.`,
        'Set --database or database.path to a file path you can write.',
      );
    // SQLite opened the file and found something else in it, or another application's database.
    // Raphael never changes such a file.
    case 'SQLITE_NOTADB':
    case 'foreign_database':
      return failure(
        'database_unusable',
        `The file at ${database} is not a Raphael database.`,
        'Set --database or database.path to another file, or move this one aside.',
      );
    case 'migration_failed':
      // The library's text names SQL, not anything the operator can change; RAPHAEL_DEBUG shows it.
      return failure(
        'database_unusable',
        `The database at ${database} could not be brought up to date: its tables do not match the migrations it records.`,
        'Restore it from a backup, or use another database with --database or database.path.',
      );
    case 'SQLITE_CORRUPT':
      return failure(
        'database_unusable',
        `The database at ${database} is damaged.`,
        'Restore it from a backup, or use another database with --database or database.path.',
      );
    case 'SQLITE_CANTOPEN':
      // A device or another file SQLite cannot keep a database in, such as /dev/null.
      return failure(
        'database_unusable',
        `The file at ${database} cannot hold a database.`,
        'Set --database or database.path to a file path you can write.',
      );
    default:
      // Not a condition the operator's settings explain - a driver that would not load, a migration
      // asset that is missing - so the cause's own message is the only clue, and it is printed as
      // the one line of context. The stack still needs RAPHAEL_DEBUG.
      return failure(
        'database_unusable',
        `Cannot open the database at ${database}: ${causeMessage(details.cause)}`,
        'Reinstall raphael if this persists, or run it again with RAPHAEL_DEBUG=1 to see where it failed.',
        EXIT_FAILURE,
      );
  }
};

/** The first line of a cause's message, escaped and otherwise as the system wrote it. */
const causeMessage = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  const line = forTerminal(text.split('\n')[0] ?? '').trim();
  if (line === '') return 'the system gave no reason.';
  return /[.!?]$/u.test(line) ? line : `${line}.`;
};

/** Whether a file's group or other users may read it. Unknown counts as no: this only warns. */
const readableByOthers = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o044) !== 0;
  } catch {
    return false;
  }
};

/**
 * `raphael server serve` with the arguments as typed, so a hint to run it again starts the same
 * server. Without them when one would need escaping for a terminal.
 */
const typedServe = (argv: readonly string[]): string =>
  argv.some((word) => forTerminal(word) !== word)
    ? 'raphael server serve'
    : ['raphael', 'server', 'serve', ...argv].map(shellArg).join(' ');

/** What a configuration failure is reported as: its typed reason is the code. */
export interface ConfigurationProblem {
  readonly reason: ConfigurationReason;
  readonly message: string;
  readonly hint?: string | undefined;
}

/**
 * A configuration problem: nothing was started and nothing is pending. A flag value is a mistake in
 * the command as typed (exit 2); everything else is configuration (exit 5).
 */
export const configurationFailure = (
  error: ConfigurationProblem,
  argv: readonly string[],
): Failure => {
  const typed = error.reason === 'option_invalid';
  return {
    code: error.reason,
    exitCode: typed ? EXIT_USAGE : EXIT_NOT_CONFIGURED,
    message: escapedLines(error.message),
    hint:
      error.hint !== undefined
        ? forTerminal(error.hint)
        : typed
          ? 'Run "raphael server serve --help" for usage.'
          : `Fix the configuration, then run "${typedServe(argv)}" again.`,
    state: 'not_sent',
    fromServer: false,
  };
};

/** A failure to start that is neither a listener nor a database problem the backend names. */
export const START_FAILED: Failure = {
  code: 'start_failed',
  exitCode: EXIT_FAILURE,
  message: 'The server could not start.',
  hint: 'Run it again with RAPHAEL_DEBUG=1 to see where it failed.',
  state: 'not_sent',
  fromServer: false,
};

const SHUTDOWN_NOTICE: Readonly<Record<'SIGINT' | 'SIGTERM', string>> = {
  SIGINT: 'Shutting down. Press Ctrl-C again to stop immediately.',
  SIGTERM: 'Received SIGTERM, shutting down. Send it again to stop immediately.',
};

export const runServe = async (
  argv: readonly string[],
  dependencies: ServeDependencies,
): Promise<ExitCode> => {
  const { configPath, overrides } = parseServeArgs(argv);
  const { streams } = dependencies;

  const backend = await loadBackend();

  let configuration;
  try {
    configuration = backend.loadConfiguration({
      ...(configPath === undefined ? {} : { configPath }),
      cwd: dependencies.cwd,
      overrides,
    });
  } catch (error) {
    if (error instanceof backend.ConfigurationError) {
      return renderFailure(streams, dependencies.session, configurationFailure(error, argv));
    }
    throw error;
  }

  // A packaged copy ships the migrations beside its bundle rather than beside the backend's sources.
  const migrations = migrationsFolder();
  const scope = Effect.runSync(Scope.make());
  let forced = false;
  const removers: Array<() => void> = [];

  try {
    const stopping = await Effect.runPromise(Deferred.make<'SIGINT' | 'SIGTERM'>());

    const arm = (signal: 'SIGINT' | 'SIGTERM'): void => {
      const remove = dependencies.onSignal(signal, () => {
        if (forced) return;
        // The handler stays registered through cleanup, so a second signal can escalate. Removing it
        // after the first would make the escalation path unreachable exactly when it is wanted.
        const already = Effect.runSync(Deferred.isDone(stopping));
        if (already) {
          forced = true;
          writeLine(
            streams.err,
            'Stopping immediately. Shutdown did not finish, so the database was not closed in an ' +
              'orderly way and in-flight requests were not awaited.',
          );
          dependencies.exit(signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM);
          return;
        }
        writeLine(streams.err, SHUTDOWN_NOTICE[signal]);
        Effect.runSync(Deferred.succeed(stopping, signal));
      });
      removers.push(remove);
    };

    const running = await Effect.runPromise(
      Scope.extend(
        backend.serve({
          options: configuration.options,
          credential: configuration.credential,
          release: version(),
          ...(migrations === undefined ? {} : { migrationsFolder: migrations }),
        }),
        scope,
      ).pipe(Effect.exit),
    );

    if (Exit.isFailure(running)) {
      // Close the listener the failure may have left bound before saying anything about it.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const error = Option.getOrUndefined(Cause.failureOption(running.cause));
      if (error instanceof backend.StartupFailure) {
        const code = renderFailure(
          streams,
          dependencies.session,
          startupFailure({ ...error, stage: error.stage, cause: error.cause }),
        );
        if (dependencies.debug === true) writeLine(streams.err, String(running.cause));
        return code;
      }
      if (error instanceof backend.ConfigurationError) {
        return renderFailure(streams, dependencies.session, configurationFailure(error, argv));
      }
      const exitCode = renderFailure(streams, dependencies.session, START_FAILED);
      if (dependencies.debug === true) writeLine(streams.err, String(running.cause));
      return exitCode;
    }

    arm('SIGINT');
    arm('SIGTERM');

    // Built from what the backend actually bound and opened, not from configuration: with port 0 or
    // a host name, the two differ. A server produces no results, so every line is for the operator
    // and goes to stderr.
    const { host, port, databasePath } = running.value;
    const everywhere = host === '0.0.0.0' || host === '::';
    const address = loginAddress(host, port);
    const { keySource } = configuration;
    for (const line of [
      everywhere
        ? `Raphael is running on every interface, port ${port}. From this machine: ${address}`
        : `Raphael is running at ${address}`,
      `Database: ${forTerminal(databasePath)}`,
      `API key:  ${keySource.variable} from ${keySource.file === undefined ? 'the environment' : forTerminal(keySource.file)}`,
      ...(keySource.file !== undefined && keySource.cutAtComment
        ? [
            `warning: In ${forTerminal(keySource.file)}, ${keySource.variable} has a "#" that starts a comment, so the key stops before it. Quote the value to keep the "#".`,
          ]
        : []),
      ...(keySource.file !== undefined && readableByOthers(keySource.file)
        ? [
            `warning: Other users of this machine can read ${forTerminal(keySource.file)}, which holds the key. Run "chmod 600 ${forTerminal(keySource.file)}".`,
          ]
        : []),
      ...(everywhere
        ? ['Other machines can reach it, and over http the key travels unencrypted.']
        : []),
      `hint: In another terminal, run "raphael login ${address}" and enter the same key.`,
      'Press Ctrl-C to stop.',
    ]) {
      writeLine(streams.err, line);
    }

    // A stop a signal asked for exits with that signal's code, as every command does, so a
    // supervisor can tell it from a server that ended by itself. The release below is the shutdown.
    return exitCodeForSignal(await Effect.runPromise(Deferred.await(stopping)));
  } finally {
    // The release is the shutdown. It runs whether the wait ended in a signal or a failure, and the
    // handlers come off only after it has finished. Closing an already closed scope does nothing.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    for (const remove of removers) remove();
  }
};
