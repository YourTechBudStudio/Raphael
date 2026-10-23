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
import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from './distribution.ts';
import {
  renderRootHelp,
  renderCommandHelp,
  renderTopicHelp,
  renderReferenceHelp,
  renderJsonHelp,
} from './help.ts';
import { ConfigError } from './modules/connection/config.ts';
import { connectionFailure } from './modules/connection/failures.ts';
import { LOGIN_DEFINITION, runLogin, terminalPrompter } from './modules/connection/login.ts';
import { LOGOUT_DEFINITION, runLogout } from './modules/connection/logout.ts';
import { ConnectionError, connectFrom } from './modules/connection/remote.ts';
import { STATUS_DEFINITION, runStatus } from './modules/connection/status.ts';
import { HELP_DEFINITION, VERSION_DEFINITION } from './modules/help.ts';
import {
  ARCHIVE_DEFINITION,
  CREATE_DEFINITION,
  FAVORITES_DEFINITION,
  FAVORITE_DEFINITION,
  GET_DEFINITION,
  LIST_DEFINITION,
  MOVE_DEFINITION,
  PATH_DEFINITION,
  RESTORE_DEFINITION,
  SEARCH_DEFINITION,
  UNFAVORITE_DEFINITION,
  UPDATE_DEFINITION,
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
import { SERVER_DEFINITION, SERVE_DEFINITION, runServe } from './modules/server/serve.ts';
import {
  UsageError,
  hasOption,
  mentionsJson,
  wantsHelp,
  parseArgs,
  type OptionConfig,
} from './shared/args.ts';
import {
  optionsFor,
  type CommandDefinition,
  type Connected,
  type Terminal,
  newSession,
  observedTransport,
  type CommandContext,
  type Invocation,
  type Session,
} from './shared/command.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_UNKNOWN, EXIT_USAGE, type ExitCode } from './shared/exit.ts';
import { renderFailure, type Failure } from './shared/failure.ts';
import { Cancelled, Interrupted, exitCodeForSignal, watchSignals } from './shared/interrupt.ts';
import {
  forTerminal,
  guardedProcessStreams,
  writeJson,
  writeLine,
  type Streams,
} from './shared/output.ts';
import { renderSuccess } from './shared/success.ts';

export interface CliEnvironment {
  readonly streams: Streams;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly cwd: string;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  readonly exit: (code: ExitCode) => void;
  /**
   * The transport for a remote command, with what it is connected to. Called only once a command has
   * parsed its arguments, so argument errors are reported before a credential is read. The entry
   * point resolves the saved login or the environment pair; tests supply a stub.
   */
  readonly connect: () => Connected;
  readonly terminal: Terminal;
}

/**
 * The remote commands. `writes` says whether a success changes stored state, which decides whether a
 * failure states how far the change got.
 */
const REMOTE_COMMANDS = {
  create: { run: runCreate, definition: CREATE_DEFINITION },
  update: { run: runUpdate, definition: UPDATE_DEFINITION },
  move: { run: runMove, definition: MOVE_DEFINITION },
  archive: { run: runArchive, definition: ARCHIVE_DEFINITION },
  restore: { run: runRestore, definition: RESTORE_DEFINITION },
  favorite: { run: runFavorite, definition: FAVORITE_DEFINITION },
  unfavorite: { run: runUnfavorite, definition: UNFAVORITE_DEFINITION },
  favorites: { run: runFavorites, definition: FAVORITES_DEFINITION },
  get: { run: runGet, definition: GET_DEFINITION },
  path: { run: runPath, definition: PATH_DEFINITION },
  list: { run: runList, definition: LIST_DEFINITION },
  search: { run: runSearch, definition: SEARCH_DEFINITION },
  status: { run: runStatus, definition: STATUS_DEFINITION },
} as const;

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  ...Object.values(REMOTE_COMMANDS).map(({ definition }) => definition),
  LOGIN_DEFINITION,
  LOGOUT_DEFINITION,
  SERVER_DEFINITION,
  SERVE_DEFINITION,
  VERSION_DEFINITION,
  HELP_DEFINITION,
];

const findDefinition = (name: string): CommandDefinition | undefined =>
  COMMAND_DEFINITIONS.find((definition) => definition.name === name);

const helpPage = (name: string): string => {
  if (name === '') return renderRootHelp(COMMAND_DEFINITIONS);
  // `help --help` and `help help` both describe the help command itself.
  const definition = findDefinition(name);
  if (definition !== undefined) return renderCommandHelp(definition);
  if (name === 'reference') return renderReferenceHelp(COMMAND_DEFINITIONS);
  const topic = renderTopicHelp(name);
  if (topic !== undefined) return topic;
  throw new UsageError(`"${name}" is not a command or help topic.`, 'help');
};

const unknownCommand = (name: string): UsageError => {
  const aliases: Readonly<Record<string, string>> = {
    ls: 'list',
    delete: 'archive',
    rm: 'archive',
    serve: 'server serve',
  };
  const lower = name.toLowerCase();
  const suggestion =
    (Object.hasOwn(aliases, lower) ? aliases[lower] : undefined) ?? findDefinition(lower)?.name;
  return new UsageError(
    `"${name}" is not a command.${suggestion === undefined ? '' : ` Did you mean "raphael ${suggestion}"?`}`,
  );
};

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
    return {
      command,
      json: asksForJson(rest, optionsFor(entry.definition)),
      writes: entry.definition.writes,
      fieldFlags: entry.definition.fieldFlags,
      verifiesItself: entry.definition.verifiesServer === true,
    };
  }
  if (command === 'login') {
    return {
      command,
      json: asksForJson(rest, optionsFor(LOGIN_DEFINITION)),
      writes: false,
      verifiesItself: true,
    };
  }
  if (command === 'logout') {
    return { command, json: asksForJson(rest, optionsFor(LOGOUT_DEFINITION)), writes: false };
  }
  // Server commands take no --json; one given anyway is still answered with a JSON error document.
  if (command === 'server') {
    const [subcommand] = rest;
    return {
      command: subcommand === 'serve' ? 'server serve' : 'server',
      json: mentionsJson(rest),
      writes: false,
    };
  }
  if (command === 'version' || command === '--version') {
    return {
      command: 'version',
      json: asksForJson(rest, optionsFor(VERSION_DEFINITION)),
      writes: false,
    };
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

  // All help is resolved before configuration, credentials, or backend loading.
  if (command === undefined || command === '--help' || command === '-h') {
    const parsed = parseArgs(rest, optionsFor(HELP_DEFINITION), 'help');
    if (parsed.positionals.length > 0)
      throw new UsageError('Root help takes no arguments.', 'help');
    writeLine(streams.out, helpPage(''));
    return EXIT_OK;
  }
  if (command === 'help') {
    const options = optionsFor(HELP_DEFINITION);
    if (wantsHelp(rest, options)) {
      writeLine(streams.out, helpPage('help'));
      return EXIT_OK;
    }
    const parsed = parseArgs(rest, options, 'help');
    const name = parsed.positionals.join(' ');
    // Validate the destination even when the result will be JSON.
    const page = helpPage(name);
    if (parsed.values.json === true) {
      writeJson(streams.out, renderJsonHelp(COMMAND_DEFINITIONS, name === '' ? undefined : name));
    } else writeLine(streams.out, page);
    return EXIT_OK;
  }
  if (command === '--version' || command === 'version') {
    if (wantsHelp(rest, optionsFor(VERSION_DEFINITION))) {
      writeLine(streams.out, helpPage('version'));
      return EXIT_OK;
    }
    const parsed = parseArgs(rest, optionsFor(VERSION_DEFINITION), 'version');
    if (parsed.positionals.length > 0)
      throw new UsageError('version takes no positional arguments.', 'version');
    // Offline: the release and the protocol this copy speaks, with no configuration read.
    return renderSuccess(streams, session, {
      data: { version: version(), protocolVersion: PROTOCOL_VERSION },
      lines: () => [version()],
    });
  }

  if (command === 'server') {
    const [subcommand, ...serverRest] = rest;
    if (subcommand === undefined || wantsHelp([subcommand], optionsFor(SERVER_DEFINITION))) {
      writeLine(streams.out, helpPage('server'));
      return EXIT_OK;
    }
    if (subcommand !== 'serve') {
      throw new UsageError(`"server ${subcommand}" is not a command.`, 'server');
    }
    if (wantsHelp(serverRest, optionsFor(SERVE_DEFINITION))) {
      writeLine(streams.out, helpPage('server serve'));
      return EXIT_OK;
    }
    return runServe(serverRest, {
      streams,
      session,
      onSignal: cli.onSignal,
      exit: cli.exit,
      cwd: cli.cwd,
      debug: cli.environment.RAPHAEL_DEBUG === '1',
    });
  }

  if (command === 'login') {
    if (wantsHelp(rest, optionsFor(LOGIN_DEFINITION))) {
      writeLine(streams.out, helpPage('login'));
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

  if (command === 'logout') {
    if (wantsHelp(rest, optionsFor(LOGOUT_DEFINITION))) {
      writeLine(streams.out, helpPage('logout'));
      return EXIT_OK;
    }
    return runLogout(rest, {
      streams,
      session,
      environment: cli.environment,
      platform: cli.platform,
    });
  }

  if (isRemoteCommand(command)) {
    const entry = REMOTE_COMMANDS[command];
    if (wantsHelp(rest, optionsFor(entry.definition))) {
      writeLine(streams.out, renderCommandHelp(entry.definition));
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
      terminal: cli.terminal,
      transport: () => {
        if (transport === undefined) {
          const connected = cli.connect();
          transport = observedTransport(session, connected.transport, connected.connection);
        }
        return transport;
      },
    };
    return entry.run(rest, context);
  }

  throw unknownCommand(command);
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
  if (error instanceof Cancelled) {
    return {
      code: 'cancelled',
      exitCode: EXIT_USAGE,
      message: forTerminal(error.message),
      hint: `Run "${error.retry}" again when you are ready.`,
      state: 'not_sent',
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
    terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
  });
  process.exitCode = code;
}
