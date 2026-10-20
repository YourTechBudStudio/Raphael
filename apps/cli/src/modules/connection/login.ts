/**
 * `raphael login`: prove the connection works, then and only then write the credential down.
 *
 * The ordering is the whole design. Validate the address locally, read the key without echoing it,
 * check the key's shape locally, make an authenticated request, confirm the answer is a Raphael
 * server speaking a protocol we understand - and only after all of that touch the filesystem. A
 * login that saved first and verified afterwards would leave a broken credential in place on failure,
 * which is worse than not having tried.
 *
 * A key is never accepted as a command-line argument. It would land in shell history and in the
 * process table for every user on the machine. Interactive input or the documented environment pair,
 * and nothing else.
 */

import { createInterface } from 'node:readline';

import { isEndpointRejection, parseEndpoint } from '@raphael/client';
import { verify } from '@raphael/client/connection';
import { hasApiKey } from '@raphael/contracts/connection';

import { UsageError, parseArgs, type OptionConfig } from '../../shared/args.ts';
import { observedTransport, type Session } from '../../shared/command.ts';
import { EXIT_USAGE, type ExitCode } from '../../shared/exit.ts';
import { describeClientFailure, renderFailure } from '../../shared/failure.ts';
import { forTerminal, type Streams } from '../../shared/output.ts';
import { renderSuccess, type Warning } from '../../shared/success.ts';
import { configLocation, saveConfig } from './config.ts';
import { API_KEY_VARIABLE, ENDPOINT_VARIABLE, timeoutFrom, transportFor } from './remote.ts';

export const LOGIN_HELP = `Usage: raphael login [--json]

Connect this machine to a Raphael server. Prompts for the server address and an API key,
verifies them, then saves them with owner-only permissions.

The key is never taken as an argument, so it stays out of shell history and the process table.
For scripts, set ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} instead of logging in.

Options:
  --json        Report the outcome as JSON on stdout. Prompts go to standard error.
  -h, --help    Show this help.`;

export interface Prompter {
  readonly ask: (question: string) => Promise<string>;
  readonly askHidden: (question: string) => Promise<string>;
  readonly close: () => void;
}

/**
 * A prompt that does not echo the key.
 *
 * Hiding is done with raw mode on the input stream, reading bytes directly, rather than by reaching
 * into readline's private output hook. Raw mode is public API; the hook is a Node internal that has
 * changed before and would take the credential prompt with it when it changes again.
 *
 * If raw mode is unavailable, the prompt fails. There is no visible-input fallback: someone typing a
 * credential into a terminal that is displaying it has already lost the thing the prompt protects.
 *
 * Terminal state is restored on every path - success, failure, and Ctrl-C - because a shell left with
 * echo disabled is a broken terminal that the person then has to work out how to fix.
 *
 * Each visible question gets its own readline interface, closed as soon as it is answered. A terminal
 * readline left attached while the key is read keeps handling keypresses and writes each one back to
 * the output, so pausing it is not enough: the key would appear on screen.
 *
 * Questions are written to stderr, never stdout: stdout carries only the result, so
 * `raphael login --json > result.json` holds exactly one JSON document.
 */
export const terminalPrompter = (): Prompter => {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'Logging in needs an interactive terminal. For scripts and CI, set ' +
        `${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} in the environment instead.`,
      'login',
    );
  }

  // Ctrl-C or Ctrl-D closes the interface without answering the question. Without the close handler
  // the promise would never settle and Node would exit 13 with a warning about its own internals.
  // After an answer the promise has already resolved, so the rejection on close is ignored.
  //
  // An address and a key pasted together arrive as one chunk, and the key's bytes go with the
  // interface that is closed here. Nothing is shown; the key prompt then waits for it to be typed.
  const ask = (question: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      rl.once('close', () => reject(new UsageError('Cancelled. Nothing was saved.', 'login')));
      rl.question(question, (answer) => {
        resolve(answer);
        rl.close();
      });
    });

  const askHidden = (question: string): Promise<string> => {
    const { stdin } = process;
    if (typeof stdin.setRawMode !== 'function') {
      throw new UsageError(
        'Cannot hide input on this terminal, and Raphael will not read a key that is being displayed. ' +
          `Set ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} in the environment instead.`,
        'login',
      );
    }

    return new Promise<string>((resolve, reject) => {
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      stdin.resume();
      process.stderr.write(question);

      let entered = '';
      const restore = (): void => {
        stdin.off('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      };

      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          switch (byte) {
            case 0x03: // Ctrl-C: restore the terminal before leaving, not after.
              restore();
              process.stderr.write('\n');
              reject(new UsageError('Cancelled. Nothing was saved.', 'login'));
              return;
            case 0x04: // Ctrl-D at an empty prompt ends input.
              if (entered === '') {
                restore();
                process.stderr.write('\n');
                reject(new UsageError('No key was entered. Nothing was saved.', 'login'));
                return;
              }
              break;
            case 0x0d:
            case 0x0a:
              restore();
              process.stderr.write('\n');
              resolve(entered);
              return;
            case 0x7f:
            case 0x08:
              entered = entered.slice(0, -1);
              break;
            default:
              // Everything else is taken verbatim, including characters the key policy will refuse.
              // Silently dropping them here would hide a mistyped key behind a length error.
              entered += String.fromCharCode(byte);
          }
        }
      };

      stdin.on('data', onData);
    });
  };

  // Nothing outlives a question, so there is nothing left to close.
  return { ask, close: () => {}, askHidden };
};

export interface LoginDependencies {
  readonly streams: Streams;
  readonly session: Session;
  /** Writes the verified credential. The real one unless a test needs an outcome a disk cannot give. */
  readonly save?: typeof saveConfig;
  readonly prompter: () => Prompter;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

export const LOGIN_OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionConfig;

export const runLogin = async (
  argv: readonly string[],
  dependencies: LoginDependencies,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, LOGIN_OPTIONS, 'login');
  const { streams } = dependencies;

  if (parsed.positionals.length > 0) {
    throw new UsageError(`"login" takes no arguments. Got "${parsed.positionals[0]}".`, 'login');
  }

  // Resolve the destination and the timeout before prompting, so a platform that cannot protect a
  // credential, or a timeout that cannot be used, is reported before asking someone to type a key.
  const location = configLocation(dependencies.environment, dependencies.platform);
  const timeoutMs = timeoutFrom(dependencies.environment);

  const prompter = dependencies.prompter();
  let endpointInput: string;
  let key: string;
  try {
    endpointInput = (await prompter.ask('Server address: ')).trim();
    key = await prompter.askHidden('API key: ');
  } finally {
    prompter.close();
  }

  const endpoint = parseEndpoint(endpointInput);
  if (isEndpointRejection(endpoint)) {
    return renderFailure(streams, dependencies.session, {
      code: endpoint.reason,
      exitCode: EXIT_USAGE,
      message: `${forTerminal(endpoint.message)} Nothing was saved.`,
      hint: 'Run "raphael login" again and give the full address, such as https://raphael.example.com.',
      state: 'not_sent',
      fromServer: false,
    });
  }

  if (!hasApiKey(key)) {
    return renderFailure(streams, dependencies.session, {
      code: 'api_key_missing',
      exitCode: EXIT_USAGE,
      message: 'No key was entered. Nothing was saved.',
      hint: 'Run "raphael login" again and enter the key the server was started with.',
      state: 'not_sent',
      fromServer: false,
    });
  }

  const config = { endpoint: endpoint.base, apiKey: key };
  const result = await verify(
    observedTransport(dependencies.session, transportFor(config, timeoutMs)),
  );
  if (!result.ok) {
    const failure = describeClientFailure(dependencies.session, result.failure);
    return renderFailure(streams, dependencies.session, {
      ...failure,
      message: `${failure.message} Nothing was saved.`,
    });
  }

  const outcome = (dependencies.save ?? saveConfig)(location, config);

  // The credential on disk is the new one even when its durability could not be confirmed. Saying
  // "login failed" would be false, and rolling back would discard a verified connection to protect
  // against a power cut that may not come; so it succeeds, with a warning.
  const warnings: Warning[] = outcome.durabilityUnconfirmed
    ? [
        {
          code: 'durability_unconfirmed',
          message:
            `Saved to ${outcome.file}, but the filesystem did not confirm the write is durable. ` +
            'If this machine loses power soon, run "raphael login" again.',
        },
      ]
    : [];

  return renderSuccess(streams, dependencies.session, {
    data: {
      endpoint: endpoint.base,
      protocolVersion: result.value.protocolVersion,
      configFile: outcome.file,
    },
    lines: () => [`Connected to ${forTerminal(endpoint.base)}.`, `Saved to ${outcome.file}.`],
    warnings,
  });
};
