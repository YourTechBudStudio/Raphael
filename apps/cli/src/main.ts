#!/usr/bin/env node
/**
 * One installed command, two contexts.
 *
 * `server serve` runs a server on this machine and never touches the saved login. Everything else is
 * a remote client and never loads the backend. Both live in one binary because there is one product,
 * and someone who has Raphael installed should not have to work out which of two executables they
 * need.
 *
 * The ordering in `dispatch` is load-bearing: help and version are answered before anything reads an
 * environment variable, opens a file, resolves a credential, or imports the backend. That is what
 * makes `raphael --help` work on a machine that is not set up, has no network, and may not be able to
 * load a native SQLite binary at all.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { Transport } from '@raphael/client';

import { version } from './distribution.ts';
import { ROOT_HELP, SERVER_HELP } from './help.ts';
import { ConfigError } from './modules/connection/config.ts';
import { connectionFailure } from './modules/connection/failures.ts';
import {
  LOGIN_HELP,
  LOGIN_OPTIONS,
  runLogin,
  terminalPrompter,
} from './modules/connection/login.ts';
import { ConnectionError, connectFrom } from './modules/connection/remote.ts';
import {
  ARCHIVE_HELP,
  CREATE_HELP,
  CREATE_OPTIONS,
  FAVORITES_HELP,
  FAVORITES_OPTIONS,
  FAVORITE_HELP,
  FAVORITE_OPTIONS,
  GET_HELP,
  GET_OPTIONS,
  LIFECYCLE_OPTIONS,
  LIST_HELP,
  LIST_OPTIONS,
  MOVE_HELP,
  MOVE_OPTIONS,
  PATH_HELP,
  PATH_OPTIONS,
  RESTORE_HELP,
  SEARCH_HELP,
  SEARCH_OPTIONS,
  UNFAVORITE_HELP,
  UPDATE_HELP,
  UPDATE_OPTIONS,
  runArchive,
  runCreate,
  runFavorite,
  runFavorites,
  runGet,
  runList,
  runMove,
  runPath,
  runRestore,
  runSearch,
  runUnfavorite,
  runUpdate,
} from './modules/nodes/commands.ts';
import { SERVE_HELP, SERVE_OPTIONS, runServe } from './modules/server/serve.ts';
import {
  UsageError,
  hasOption,
  mentionsJson,
  wantsHelp,
  type OptionConfig,
} from './shared/args.ts';
import {
  newSession,
  observedTransport,
  type CommandContext,
  type Invocation,
  type Session,
} from './shared/command.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_UNKNOWN, EXIT_USAGE, type ExitCode } from './shared/exit.ts';
import { renderFailure, type Failure } from './shared/failure.ts';
import { Interrupted, exitCodeForSignal, watchSignals } from './shared/interrupt.ts';
import { forTerminal, guardedProcessStreams, writeLine, type Streams } from './shared/output.ts';

export interface CliEnvironment {
  readonly streams: Streams;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly cwd: string;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  readonly exit: (code: ExitCode) => void;
  /**
   * The transport for a remote command. Called only once a command has parsed its arguments, so
   * argument errors are reported before a credential is read. The entry point resolves the saved
   * login or the environment pair; tests supply a stub.
   */
  readonly connect: () => Transport;
}

/**
 * The remote commands. `writes` says whether a success changes stored state, which decides whether a
 * failure states how far the change got.
 */
const REMOTE_COMMANDS = {
  create: { run: runCreate, help: CREATE_HELP, options: CREATE_OPTIONS, writes: true },
  update: { run: runUpdate, help: UPDATE_HELP, options: UPDATE_OPTIONS, writes: true },
  move: { run: runMove, help: MOVE_HELP, options: MOVE_OPTIONS, writes: true },
  archive: { run: runArchive, help: ARCHIVE_HELP, options: LIFECYCLE_OPTIONS, writes: true },
  restore: { run: runRestore, help: RESTORE_HELP, options: LIFECYCLE_OPTIONS, writes: true },
  favorite: { run: runFavorite, help: FAVORITE_HELP, options: FAVORITE_OPTIONS, writes: true },
  unfavorite: {
    run: runUnfavorite,
    help: UNFAVORITE_HELP,
    options: FAVORITE_OPTIONS,
    writes: true,
  },
  favorites: { run: runFavorites, help: FAVORITES_HELP, options: FAVORITES_OPTIONS, writes: false },
  get: { run: runGet, help: GET_HELP, options: GET_OPTIONS, writes: false },
  path: { run: runPath, help: PATH_HELP, options: PATH_OPTIONS, writes: false },
  list: { run: runList, help: LIST_HELP, options: LIST_OPTIONS, writes: false },
  search: { run: runSearch, help: SEARCH_HELP, options: SEARCH_OPTIONS, writes: false },
} as const;

/** `server` has no options of its own; only help is recognized before the subcommand. */
const SERVER_OPTIONS = { help: { type: 'boolean', short: 'h' } } as const satisfies OptionConfig;

type RemoteCommandName = keyof typeof REMOTE_COMMANDS;

/** Every remote command, so tests can require each one's help to be pinned. */
export const REMOTE_COMMAND_NAMES = Object.keys(REMOTE_COMMANDS) as readonly RemoteCommandName[];

const isRemoteCommand = (name: string): name is RemoteCommandName =>
  Object.hasOwn(REMOTE_COMMANDS, name);

/**
 * What is known before anything runs: the command, whether `--json` was asked for, and whether it
 * writes. Decided from the arguments alone, so a usage error found while parsing them is still
 * reported in the form the caller asked for.
 */
/**
 * Whether `--json` was asked for. The token-aware check answers for arguments that parse; the raw
 * scan before `--` answers when they do not, as in `get --id --json`, where the lenient parser takes
 * `--json` as the missing value. Strict parsing refuses a bare `--json` given as a value, so the raw
 * scan can never call a successful parse JSON that was not.
 */
const asksForJson = (argv: readonly string[], options: OptionConfig): boolean =>
  hasOption(argv, options, 'json') || mentionsJson(argv);

export const invocationOf = (argv: readonly string[]): Invocation => {
  const [command, ...rest] = argv;
  if (command !== undefined && isRemoteCommand(command)) {
    const entry = REMOTE_COMMANDS[command];
    return { command, json: asksForJson(rest, entry.options), writes: entry.writes };
  }
  if (command === 'login') {
    return { command, json: asksForJson(rest, LOGIN_OPTIONS), writes: false };
  }
  // These take no --json yet; one given anyway is still answered with a JSON error document.
  if (command === 'server') {
    const [subcommand] = rest;
    return {
      command: subcommand === 'serve' ? 'server serve' : 'server',
      json: mentionsJson(rest),
      writes: false,
    };
  }
  if (command === 'version' || command === '--version') {
    return { command: 'version', json: mentionsJson(rest), writes: false };
  }
  return { command: null, json: mentionsJson(argv), writes: false };
};

export const dispatch = async (
  argv: readonly string[],
  cli: CliEnvironment,
  session: Session = newSession(invocationOf(argv)),
): Promise<ExitCode> => {
  const { streams } = cli;
  const [command, ...rest] = argv;

  // Before anything else. No configuration, no environment, no network, no backend.
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    writeLine(streams.out, ROOT_HELP);
    return EXIT_OK;
  }
  if (command === '--version' || command === 'version') {
    // Anything after it is refused rather than dropped: `raphael --version archive /work` exiting 0
    // would tell a script the archive happened.
    if (rest.length > 0) {
      throw new UsageError(`"${command}" takes no arguments. Got "${rest[0]}".`);
    }
    writeLine(streams.out, version());
    return EXIT_OK;
  }

  if (command === 'server') {
    const [subcommand, ...serverRest] = rest;
    if (subcommand === undefined || wantsHelp([subcommand], SERVER_OPTIONS)) {
      writeLine(streams.out, SERVER_HELP);
      return EXIT_OK;
    }
    if (subcommand !== 'serve') {
      throw new UsageError(`"server ${subcommand}" is not a command.`, 'server');
    }
    if (wantsHelp(serverRest, SERVE_OPTIONS)) {
      writeLine(streams.out, SERVE_HELP);
      return EXIT_OK;
    }
    return runServe(serverRest, {
      streams,
      session,
      onSignal: cli.onSignal,
      exit: cli.exit,
      cwd: cli.cwd,
    });
  }

  if (command === 'login') {
    if (wantsHelp(rest, LOGIN_OPTIONS)) {
      writeLine(streams.out, LOGIN_HELP);
      return EXIT_OK;
    }
    return runLogin(rest, {
      streams,
      session,
      prompter: terminalPrompter,
      environment: cli.environment,
      platform: cli.platform,
    });
  }

  if (isRemoteCommand(command)) {
    const entry = REMOTE_COMMANDS[command];
    if (wantsHelp(rest, entry.options)) {
      writeLine(streams.out, entry.help);
      return EXIT_OK;
    }
    // A signal cancels what the command is waiting on, and the command then ends through the failure
    // renderer, which says whether the change was sent. A second signal does not wait for that.
    const interruption = watchSignals(cli.onSignal, (signal) =>
      cli.exit(exitCodeForSignal(signal)),
    );
    session.interruption = interruption;
    // The transport is built lazily, inside the command, so that argument errors are reported before
    // a credential is read. Someone with a typo in a flag should not first be told they are not
    // logged in.
    let transport: Transport | undefined;
    const context: CommandContext = {
      streams,
      session,
      signal: interruption.signal,
      transport: () => (transport ??= observedTransport(session, cli.connect())),
    };
    return entry.run(rest, context);
  }

  throw new UsageError(`"${command}" is not a command.`);
};

/**
 * Describe anything thrown past a command: a usage error, a connection that could not be set up, an
 * interruption while waiting on input, or a fault of our own.
 */
export const failureFromThrown = (error: unknown, session: Session): Failure => {
  if (error instanceof Interrupted) {
    const sent = session.writeSent;
    return {
      code: 'interrupted',
      exitCode: exitCodeForSignal(error.signal) as Failure['exitCode'],
      message: `Interrupted by ${error.signal}.`,
      hint: sent
        ? 'Check whether the change was applied before sending it again.'
        : 'Run the command again.',
      state: sent ? 'unknown' : 'not_sent',
      fromServer: false,
    };
  }
  if (error instanceof UsageError) {
    return {
      code: 'usage',
      exitCode: EXIT_USAGE,
      message: forTerminal(error.message),
      hint:
        error.command === undefined
          ? 'Run "raphael help" to see the commands.'
          : `Run "raphael ${error.command} --help" for usage.`,
      state: 'not_sent',
      fromServer: false,
    };
  }
  if (error instanceof ConfigError || error instanceof ConnectionError) {
    return connectionFailure(error);
  }
  // Anything else is ours. The message is printed because it is the only clue available; no stack and
  // no cause chain unless RAPHAEL_DEBUG asks for them, because those carry paths and internals.
  const sent = session.writeSent;
  return {
    code: 'unexpected',
    exitCode: sent ? EXIT_UNKNOWN : EXIT_FAILURE,
    message: forTerminal(
      error instanceof Error && error.message !== ''
        ? error.message
        : 'An unexpected failure occurred.',
    ),
    hint: 'Run it again with RAPHAEL_DEBUG=1 to see where it failed.',
    state: sent ? 'unknown' : 'not_sent',
    fromServer: false,
  };
};

/** Turn a thrown failure into an exit code and a message that is safe to print. */
export const toExitCode = (
  error: unknown,
  streams: Streams,
  session: Session = newSession({ command: null, json: false, writes: false }),
  debug = false,
): ExitCode => {
  const code = renderFailure(streams, session, failureFromThrown(error, session));
  if (debug && error instanceof Error && error.stack !== undefined) {
    writeLine(streams.err, error.stack);
  }
  return code;
};

export const run = async (argv: readonly string[], cli: CliEnvironment): Promise<ExitCode> => {
  const session = newSession(invocationOf(argv));
  try {
    return await dispatch(argv, cli, session);
  } catch (error) {
    return toExitCode(error, cli.streams, session, cli.environment.RAPHAEL_DEBUG === '1');
  } finally {
    // The command has its outcome; nothing is waiting to be cancelled any more.
    session.interruption?.release();
  }
};

/**
 * Whether this module is the program being run, rather than something that imported it.
 *
 * Compared as resolved file URLs. A basename comparison would be true for any script called
 * `main.js`, and the installed `raphael` is reached through a symbolic link in `node_modules/.bin`,
 * so both sides are resolved before they are compared.
 */
const isEntryPoint = (): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return pathToFileURL(realpathSync(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isEntryPoint()) {
  const code = await run(process.argv.slice(2), {
    streams: guardedProcessStreams(),
    environment: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    exit: (value) => process.exit(value),
    connect: () => connectFrom(process.env, process.platform),
  });
  process.exitCode = code;
}
