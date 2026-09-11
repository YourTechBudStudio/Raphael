/**
 * `raphael server serve`: the local administration side of the one installed command.
 *
 * Two things make this different from every other command here.
 *
 * **The backend is loaded lazily, and only here.** `import('@raphael/backend')` initializes a native
 * SQLite driver. Help, version, and every remote command must work without that, on a machine where
 * the native binary may not even load, so the import sits inside this function rather than at the top
 * of any module the dispatcher touches. Note what this does and does not buy: it keeps the driver out
 * of the *process*, not out of the *installation*.
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

import { Deferred, Effect, Exit, Scope } from 'effect';

import { UsageError, parseArgs, stringOption } from '../../shared/args.ts';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_USAGE,
  type ExitCode,
} from '../../shared/exit.ts';
import { writeLine, type Streams } from '../../shared/output.ts';

export const SERVE_HELP = `Usage: raphael server serve [--config <path>]

Run a Raphael server on this machine.

Configuration comes from a YAML file and the API key comes from the environment, or from a
.env file beside the command you run. Relative database paths resolve against the configuration
file's directory, or the current directory when no file is given.

This command never reads your saved login: it runs a server, it does not connect to one.

Options:
      --config <path>  YAML configuration file.
  -h, --help           Show this help.`;

export interface ServeDependencies {
  readonly streams: Streams;
  /** Registers a handler and returns a function that removes it. Tests supply their own. */
  readonly onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => () => void;
  /** Forced termination. Separated so a test can observe it instead of dying. */
  readonly exit: (code: ExitCode) => void;
  readonly cwd: string;
}

/** Loaded lazily so that nothing else in this process pays for the native driver. */
const loadBackend = async (): Promise<typeof import('@raphael/backend')> =>
  import('@raphael/backend');

export const runServe = async (
  argv: readonly string[],
  dependencies: ServeDependencies,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    'server serve',
  );
  if (parsed.positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${parsed.positionals[0]}".`, 'server serve');
  }
  const configPath = stringOption(parsed, 'config', 'server serve');
  const { streams } = dependencies;

  const backend = await loadBackend();

  let configuration;
  try {
    configuration = backend.loadConfiguration({
      ...(configPath === undefined ? {} : { configPath }),
      cwd: dependencies.cwd,
    });
  } catch (error) {
    if (error instanceof backend.ConfigurationError) {
      // A configuration problem is a local setup failure: nothing was started and nothing is pending,
      // which is what exit 2 means here. The typed reason is used rather than the raw cause.
      writeLine(streams.err, error.message);
      writeLine(streams.err, `  reason: ${error.reason}`);
      return EXIT_USAGE;
    }
    throw error;
  }

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
        writeLine(
          streams.err,
          `Received ${signal}, shutting down. Press again to stop immediately.`,
        );
        Effect.runSync(Deferred.succeed(stopping, signal));
      });
      removers.push(remove);
    };

    const running = await Effect.runPromise(
      Scope.extend(
        backend.serve({ options: configuration.options, credential: configuration.credential }),
        scope,
      ).pipe(Effect.exit),
    );

    if (Exit.isFailure(running)) {
      writeLine(streams.err, 'The server could not start.');
      writeLine(streams.err, String(running.cause));
      return EXIT_FAILURE;
    }

    arm('SIGINT');
    arm('SIGTERM');

    // The bound address is reported by the backend's own startup log. Repeating it here would be a
    // second claim about the same fact, from a component that did not establish it.
    writeLine(streams.out, 'Press Ctrl-C to stop.');

    await Effect.runPromise(Deferred.await(stopping));
    return EXIT_OK;
  } finally {
    // The release is the shutdown. It runs whether the wait ended in a signal or a failure, and the
    // handlers come off only after it has finished.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    for (const remove of removers) remove();
  }
};
