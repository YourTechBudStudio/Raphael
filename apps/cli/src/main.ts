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

import { ROOT_HELP, SERVER_HELP, version } from './help.ts';
import { ConfigError } from './modules/connection/config.ts';
import { LOGIN_HELP, runLogin, terminalPrompter } from './modules/connection/login.ts';
import { ConnectionError, resolveConnection, transportFor } from './modules/connection/remote.ts';
import {
  CREATE_HELP,
  GET_HELP,
  LIST_HELP,
  PATH_HELP,
  runCreate,
  runGet,
  runList,
  runPath,
  type CommandContext,
} from './modules/nodes/commands.ts';
import { SERVE_HELP, runServe } from './modules/server/serve.ts';
import { UsageError, wantsHelp } from './shared/args.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ExitCode } from './shared/exit.ts';
import { processStreams, writeLine, type Streams } from './shared/output.ts';

export interface CliEnvironment {
  readonly streams: Streams;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly cwd: string;
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  readonly exit: (code: ExitCode) => void;
}

const REMOTE_COMMANDS = {
  create: { run: runCreate, help: CREATE_HELP },
  get: { run: runGet, help: GET_HELP },
  path: { run: runPath, help: PATH_HELP },
  list: { run: runList, help: LIST_HELP },
} as const;

type RemoteCommandName = keyof typeof REMOTE_COMMANDS;

const isRemoteCommand = (name: string): name is RemoteCommandName =>
  Object.hasOwn(REMOTE_COMMANDS, name);

export const dispatch = async (argv: readonly string[], cli: CliEnvironment): Promise<ExitCode> => {
  const { streams } = cli;
  const [command, ...rest] = argv;

  // Before anything else. No configuration, no environment, no network, no backend.
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    writeLine(streams.out, ROOT_HELP);
    return EXIT_OK;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    writeLine(streams.out, version());
    return EXIT_OK;
  }

  if (command === 'server') {
    const [subcommand, ...serverRest] = rest;
    if (subcommand === undefined || wantsHelp([subcommand])) {
      writeLine(streams.out, SERVER_HELP);
      return EXIT_OK;
    }
    if (subcommand !== 'serve') {
      throw new UsageError(`"server ${subcommand}" is not a command.`, 'server');
    }
    if (wantsHelp(serverRest)) {
      writeLine(streams.out, SERVE_HELP);
      return EXIT_OK;
    }
    return runServe(serverRest, {
      streams,
      onSignal: cli.onSignal,
      exit: cli.exit,
      cwd: cli.cwd,
    });
  }

  if (command === 'login') {
    if (wantsHelp(rest)) {
      writeLine(streams.out, LOGIN_HELP);
      return EXIT_OK;
    }
    return runLogin(rest, {
      streams,
      prompter: terminalPrompter,
      environment: cli.environment,
      platform: cli.platform,
    });
  }

  if (isRemoteCommand(command)) {
    const entry = REMOTE_COMMANDS[command];
    if (wantsHelp(rest)) {
      writeLine(streams.out, entry.help);
      return EXIT_OK;
    }
    // The transport is built lazily, inside the command, so that argument errors are reported before
    // a credential is read. Someone with a typo in a flag should not first be told they are not
    // logged in.
    const context: CommandContext = {
      streams,
      transport: () => {
        const connection = resolveConnection(cli.environment, cli.platform);
        return transportFor(connection.config);
      },
    };
    return entry.run(rest, context);
  }

  throw new UsageError(`"${command}" is not a command.`);
};

/** Turn an unhandled failure into an exit code and a message that is safe to print. */
export const toExitCode = (error: unknown, streams: Streams): ExitCode => {
  if (error instanceof UsageError) {
    writeLine(streams.err, error.message);
    writeLine(
      streams.err,
      error.command === undefined
        ? 'Run "raphael help" to see the commands.'
        : `Run "raphael ${error.command} --help" for usage.`,
    );
    return EXIT_USAGE;
  }
  if (error instanceof ConfigError) {
    writeLine(streams.err, error.message);
    writeLine(streams.err, `  reason: ${error.reason}`);
    // A credential that is not set up, or not protected, is something to fix locally before anything
    // is sent - the same class of problem as a mistyped flag.
    return EXIT_USAGE;
  }
  if (error instanceof ConnectionError) {
    writeLine(streams.err, error.message);
    writeLine(streams.err, `  reason: ${error.reason}`);
    return EXIT_USAGE;
  }
  // Anything else is ours. The message is printed because it is the only clue available; no stack and
  // no cause chain, because those carry paths and internals.
  writeLine(
    streams.err,
    error instanceof Error ? error.message : 'An unexpected failure occurred.',
  );
  return EXIT_FAILURE;
};

export const run = async (argv: readonly string[], cli: CliEnvironment): Promise<ExitCode> => {
  try {
    return await dispatch(argv, cli);
  } catch (error) {
    return toExitCode(error, cli.streams);
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
    streams: processStreams,
    environment: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    exit: (value) => process.exit(value),
  });
  process.exitCode = code;
}
