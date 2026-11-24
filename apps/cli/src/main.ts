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
  HELP_TOPICS,
  renderRootHelp,
  renderCommandHelp,
  renderTopicHelp,
  renderReferenceHelp,
  renderJsonHelp,
} from './help.ts';
import { ConfigError } from './modules/connection/config.ts';
import { connectionFailure } from './modules/connection/failures.ts';
import {
  LOGIN_DEFINITION,
  LOGIN_STATE_LINE,
  runLogin,
  terminalPrompter,
} from './modules/connection/login.ts';
import { LOGOUT_DEFINITION, LOGOUT_STATE_LINE, runLogout } from './modules/connection/logout.ts';
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
  editDistance,
  type Correction,
  hasOption,
  mentionsJson,
  wantsHelp,
  parseArgs,
  parses,
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
import { EXIT_FAILURE, EXIT_UNKNOWN, EXIT_USAGE, type ExitCode } from './shared/exit.ts';
import { shellArg } from './shared/failure-wording.ts';
import { renderFailure, type Failure } from './shared/failure.ts';
import { Cancelled, Interrupted, exitCodeForSignal, watchSignals } from './shared/interrupt.ts';
import {
  forTerminal,
  flushProcessStreams,
  guardedProcessStreams,
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
  const suggestion = suggestedHelp(name);
  throw new UsageError(
    `"${name}" is not a command or help topic.`,
    'help',
    suggestion === undefined
      ? 'Run "raphael help" to see the commands and topics.'
      : `Did you mean "raphael help ${suggestion}"?`,
  );
};

/**
 * Answer a help request, whichever way it was spelled: `help <x>`, `<x> --help`, `<x> -h`, or the
 * root page from `help`, `--help` or `-h`. The text is the same bytes for every spelling; with
 * `--json` it is one success document for the `help` command, through the one success renderer.
 */
const answerHelp = (streams: Streams, name: string, json: boolean): ExitCode => {
  // Resolved first, so an unknown name is refused the same way as text or as JSON.
  const page = helpPage(name);
  return renderSuccess(streams, newSession({ command: 'help', json, writes: false }), {
    data: renderJsonHelp(COMMAND_DEFINITIONS, name),
    lines: () => [page],
  });
};

/**
 * What a help name that is neither a command nor a topic most likely meant. A topic it names exactly
 * or begins (three letters or more) wins, as in `help exit`; then a command, as `suggestedCommand`
 * finds one; then the closest topic within two edits.
 */
const suggestedHelp = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  const topics = [...HELP_TOPICS.map((topic) => topic.name), 'reference'];
  const named =
    topics.find((topic) => topic === lower) ??
    (lower.length >= 3 ? topics.find((topic) => topic.startsWith(lower)) : undefined);
  if (named !== undefined) return named;
  const command = suggestedCommand(name);
  if (command !== undefined) return command;
  let closest: { readonly topic: string; readonly distance: number } | undefined;
  for (const topic of topics) {
    const distance = editDistance(lower, topic);
    if (distance <= 2 && distance < lower.length && distance < (closest?.distance ?? Infinity)) {
      closest = { topic, distance };
    }
  }
  return closest?.topic;
};

/** Names people reach for that are not commands, and the command each one means. */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  ls: 'list',
  mv: 'move',
  delete: 'archive',
  rm: 'archive',
  remove: 'archive',
  // Named here because the closest spelling is the opposite operation.
  unarchive: 'restore',
  new: 'create',
  add: 'create',
  mk: 'create',
  edit: 'update',
  set: 'update',
  show: 'get',
  cat: 'get',
  read: 'get',
  find: 'search',
  grep: 'search',
  serve: 'server serve',
};

/**
 * The command a mistyped name most likely meant: an alias, the same name in another case, a name it
 * begins (three letters or more), or the closest name or alias within two edits. A word that short
 * edits are most of is too far from anything to guess at.
 */
export const suggestedCommand = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  if (Object.hasOwn(COMMAND_ALIASES, lower)) return COMMAND_ALIASES[lower];
  // Each spelling a suggestion can come from, with the command it means, in the table's order. A
  // group such as `server` means its runnable command, `server serve`.
  const spellings: ReadonlyArray<readonly [string, string]> = [
    ...COMMAND_DEFINITIONS.filter(({ name: command }) => command !== 'server').map(
      ({ name: command }): [string, string] => [command.split(' ')[0] ?? command, command],
    ),
    ...Object.entries(COMMAND_ALIASES),
  ];
  const exact = spellings.find(([spelling]) => spelling === lower);
  if (exact !== undefined) return exact[1];
  if (lower.length >= 3) {
    const begun = spellings.find(([spelling]) => spelling.startsWith(lower));
    if (begun !== undefined) return begun[1];
  }
  let closest: { readonly command: string; readonly distance: number } | undefined;
  for (const [spelling, command] of spellings) {
    const distance = editDistance(lower, spelling);
    if (distance <= 2 && distance < lower.length && distance < (closest?.distance ?? Infinity)) {
      closest = { command, distance };
    }
  }
  return closest?.command;
};

/** Whether a word is a help topic, as in `raphael addressing --help`. */
const isTopic = (word: string): boolean =>
  word === 'reference' || HELP_TOPICS.some((topic) => topic.name === word);

const unknownCommand = (argv: readonly string[]): UsageError => {
  const [name = '', ...rest] = argv;
  if (name.startsWith('-')) {
    // Options before the command, as in `raphael --json get /x` or `raphael --id 3 get`: the first
    // command name after them is the command, and everything before it goes after it, values and
    // all. A `--` there separates nothing, so it is left out.
    const at = rest.findIndex((word) => findDefinition(word) !== undefined);
    const command = at === -1 ? undefined : rest[at];
    const message =
      name === '--'
        ? '"--" cannot come before the command.'
        : `"${name}" is an option, not a command.`;
    const definition = command === undefined ? undefined : findDefinition(command);
    if (command === undefined || definition === undefined) return new UsageError(message);
    const leading = [name, ...rest.slice(0, at)].filter((word) => word !== '--');
    const moved = [...rest.slice(at + 1), ...leading];
    // Suggested only when it parses: an option the command does not take is no better after it.
    if (command !== 'server' && !parses(moved, optionsFor(definition))) {
      return new UsageError(message, command);
    }
    const reordered = ['raphael', command, ...moved].map(shellArg).join(' ');
    return new UsageError(message, undefined, `Put options after the command, as in "${reordered}".`);
  }
  // A topic is read through help: `raphael addressing --help` meant `raphael help addressing`.
  if (isTopic(name)) {
    return new UsageError(
      `"${name}" is a help topic, not a command.`,
      undefined,
      `Did you mean "raphael help ${name}"?`,
    );
  }
  const suggestion = suggestedCommand(name);
  return new UsageError(
    `"${name}" is not a command.`,
    undefined,
    suggestion === undefined ? undefined : `Did you mean "raphael ${suggestion}"?`,
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

/** The root page is asked for: no arguments, `--help` or `-h`, or `--json` before either. */
const asksForRootHelp = (argv: readonly string[]): boolean => {
  const [command, ...rest] = argv;
  return (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    (command === '--json' && (rest[0] === '--help' || rest[0] === '-h'))
  );
};

export const invocationOf = (argv: readonly string[]): Invocation => ({
  ...commandInvocation(argv),
  argv,
});

/** `--json --version` is `--version --json`, as `--json --help` is `--help --json`. */
const versionFirst = (argv: readonly string[]): readonly string[] | undefined =>
  argv[0] === '--json' && argv[1] === '--version' ? ['--version', '--json', ...argv.slice(2)] : undefined;

const commandInvocation = (argv: readonly string[]): Invocation => {
  const reordered = versionFirst(argv);
  if (reordered !== undefined) return commandInvocation(reordered);
  const [command, ...rest] = argv;
  if (asksForRootHelp(argv) || command === 'help') {
    return {
      command: 'help',
      json: asksForJson(command === 'help' ? rest : argv, optionsFor(HELP_DEFINITION)),
      writes: false,
    };
  }
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
      stateLine: LOGIN_STATE_LINE,
      verifiesItself: true,
    };
  }
  if (command === 'logout') {
    return {
      command,
      json: asksForJson(rest, optionsFor(LOGOUT_DEFINITION)),
      writes: false,
      stateLine: LOGOUT_STATE_LINE,
    };
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
  const reordered = versionFirst(argv);
  if (reordered !== undefined) return dispatch(reordered, cli, session);
  const { streams } = cli;
  const [command, ...rest] = argv;

  // All help is resolved before configuration, credentials, or backend loading. Whether it is JSON
  // was decided with the invocation, from the same tokens.
  const { json } = session.invocation;
  if (command === undefined || asksForRootHelp(argv)) {
    // `--json --help`: the leading --json is an option like any other here.
    const parsed = parseArgs(
      command === '--json' ? argv.slice(2) : rest,
      optionsFor(HELP_DEFINITION),
      'help',
    );
    // `raphael -h list` is `raphael help list`; the page is named, not given to --help.
    if (parsed.positionals.length > 0) {
      const named = parsed.positionals.join(' ');
      const page = findDefinition(named) !== undefined || isTopic(named) ? named : undefined;
      const flag = argv.find((word) => word === '-h' || word === '--help') ?? '--help';
      throw new UsageError(
        `${flag} takes no command or topic name.`,
        'help',
        page === undefined
          ? 'Run "raphael help" to see the commands and topics.'
          : `Did you mean "raphael help ${page}"?`,
      );
    }
    return answerHelp(streams, '', json);
  }
  if (command === 'help') {
    const options = optionsFor(HELP_DEFINITION);
    if (wantsHelp(rest, options)) return answerHelp(streams, 'help', json);
    const parsed = parseArgs(rest, options, 'help');
    return answerHelp(streams, parsed.positionals.join(' '), parsed.values.json === true);
  }
  if (command === '--version' || command === 'version') {
    if (wantsHelp(rest, optionsFor(VERSION_DEFINITION)))
      return answerHelp(streams, 'version', json);
    const parsed = parseArgs(rest, optionsFor(VERSION_DEFINITION), 'version');
    if (parsed.positionals.length > 0)
      throw new UsageError('version takes no arguments.', 'version');
    // Offline: the release and the protocol this copy speaks, with no configuration read.
    return renderSuccess(streams, session, {
      data: { version: version(), protocolVersion: PROTOCOL_VERSION },
      lines: () => [version()],
    });
  }

  if (command === 'server') {
    const [subcommand, ...serverRest] = rest;
    // `server --help`, also after another option as in `server --json --help`; `server serve --help`
    // is serve's own page.
    if (
      subcommand === undefined ||
      (subcommand.startsWith('-') && wantsHelp(rest, optionsFor(SERVER_DEFINITION)))
    ) {
      return answerHelp(streams, 'server', json);
    }
    if (subcommand !== 'serve') {
      // Serve is the only server command, so it is what any other name meant; `server help` is
      // answered by the usage hint instead.
      throw new UsageError(
        `"server ${subcommand}" is not a command.`,
        'server',
        subcommand === 'help' ? undefined : 'Did you mean "raphael server serve"?',
      );
    }
    if (wantsHelp(serverRest, optionsFor(SERVE_DEFINITION))) {
      return answerHelp(streams, 'server serve', json);
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
    if (wantsHelp(rest, optionsFor(LOGIN_DEFINITION))) return answerHelp(streams, 'login', json);
    // As for a remote command: a signal ends the prompt, the read or the request, and login ends
    // through the failure renderer.
    const interruption = watchSignals(cli.onSignal, (signal) =>
      cli.exit(exitCodeForSignal(signal)),
    );
    session.interruption = interruption;
    return runLogin(rest, {
      streams,
      session,
      prompter: terminalPrompter,
      environment: cli.environment,
      platform: cli.platform,
      signal: interruption.signal,
    });
  }

  if (command === 'logout') {
    if (wantsHelp(rest, optionsFor(LOGOUT_DEFINITION))) return answerHelp(streams, 'logout', json);
    return runLogout(rest, {
      streams,
      session,
      environment: cli.environment,
      platform: cli.platform,
    });
  }

  if (isRemoteCommand(command)) {
    const entry = REMOTE_COMMANDS[command];
    if (wantsHelp(rest, optionsFor(entry.definition))) return answerHelp(streams, command, json);
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

  throw unknownCommand(argv);
};

/** Longer than this, a repeated command is no longer a hint anyone reads; the words are used instead. */
const CORRECTED_COMMAND_MAX_LENGTH = 160;

/**
 * The command as typed with one argument replaced by its correction, ready to run: only when that
 * argument appears exactly once (an option possibly with its `=value`), nothing in the command needs escaping for a terminal, and the
 * result is short enough to read as a hint.
 */
const correctedCommand = (
  argv: readonly string[] | undefined,
  { typed, suggested }: Correction,
): string | undefined => {
  // An option may carry its value joined with `=`; only the name is replaced.
  const words = typeof suggested === 'string' ? [suggested] : suggested;
  const fix = (word: string): readonly string[] | undefined =>
    word === typed
      ? words
      : typed.startsWith('-') && word.startsWith(`${typed}=`) && typeof suggested === 'string'
        ? [`${suggested}${word.slice(typed.length)}`]
        : undefined;
  if (argv === undefined || argv.filter((word) => fix(word) !== undefined).length !== 1) {
    return undefined;
  }
  if (argv.some((word) => forTerminal(word) !== word)) return undefined;
  const command = ['raphael', ...argv.flatMap((word) => fix(word) ?? [word])]
    .map(shellArg)
    .join(' ');
  return command.length > CORRECTED_COMMAND_MAX_LENGTH ? undefined : command;
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
    const corrected =
      error.correction === undefined
        ? undefined
        : correctedCommand(session.invocation.argv, error.correction);
    return {
      code: 'usage',
      exitCode: EXIT_USAGE,
      message: forTerminal(error.message),
      ...(error.field === undefined ? {} : { field: error.field }),
      // A refusal that knows the exact correction gives it as the next step, as the whole command
      // when it can be repeated; otherwise the next step is the help that explains the usage.
      hint:
        corrected !== undefined
          ? `Did you mean "${corrected}"?`
          : error.fix !== undefined
            ? forTerminal(error.fix)
            : error.command === undefined
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
  // With --json, stderr holds the one error document and nothing a parser would trip on.
  if (debug && !session.invocation.json && error instanceof Error && error.stack !== undefined) {
    writeLine(streams.err, error.stack);
  }
  return code;
};

export const run = async (argv: readonly string[], cli: CliEnvironment): Promise<ExitCode> => {
  const session = newSession(invocationOf(argv), cli.environment.RAPHAEL_DEBUG === '1');
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
  // Node opens an inspector on SIGUSR1 unless something listens for it, and any local user could
  // attach to it and read a key from memory. Listening is Node's supported way to keep it closed.
  process.on('SIGUSR1', () => {});
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
  // The outcome is decided and printed. Nothing left in the event loop - a connection attempt still
  // pending after a timeout or an interruption gave up on it - may hold the process past it.
  await flushProcessStreams();
  process.exit(code);
}
