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
import { inspectApiKey } from '@raphael/contracts/connection';

import { UsageError, parseArgs } from '../../shared/args.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ExitCode } from '../../shared/exit.ts';
import { forTerminal, writeJson, writeLine, type Streams } from '../../shared/output.ts';
import { reportFailure } from '../../shared/report.ts';
import { configLocation, saveConfig } from './config.ts';
import {
  API_KEY_VARIABLE,
  ENDPOINT_VARIABLE,
  describeKeyRejection,
  transportFor,
} from './remote.ts';

export const LOGIN_HELP = `Usage: raphael login [--json]

Connect this machine to a Raphael server. Prompts for the server address and an API key,
verifies them, then saves them with owner-only permissions.

The key is never taken as an argument, so it stays out of shell history and the process table.
For scripts, set ${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} instead of logging in.

Options:
  --json        Report the outcome as JSON on stdout.
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
 */
export const terminalPrompter = (): Prompter => {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'Logging in needs an interactive terminal. For scripts and CI, set ' +
        `${ENDPOINT_VARIABLE} and ${API_KEY_VARIABLE} in the environment instead.`,
      'login',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

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
      // readline is paused for the duration so the two do not both consume the stream.
      rl.pause();
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      stdin.resume();
      process.stdout.write(question);

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
              process.stdout.write('\n');
              reject(new UsageError('Cancelled. Nothing was saved.', 'login'));
              return;
            case 0x04: // Ctrl-D at an empty prompt ends input.
              if (entered === '') {
                restore();
                process.stdout.write('\n');
                reject(new UsageError('No key was entered. Nothing was saved.', 'login'));
                return;
              }
              break;
            case 0x0d:
            case 0x0a:
              restore();
              process.stdout.write('\n');
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

  return { ask, close: () => rl.close(), askHidden };
};

export interface LoginDependencies {
  readonly streams: Streams;
  readonly prompter: () => Prompter;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

export const runLogin = async (
  argv: readonly string[],
  dependencies: LoginDependencies,
): Promise<ExitCode> => {
  const parsed = parseArgs(
    argv,
    { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    'login',
  );
  const asJson = parsed.values.json === true;
  const { streams } = dependencies;

  if (parsed.positionals.length > 0) {
    throw new UsageError(`"login" takes no arguments. Got "${parsed.positionals[0]}".`, 'login');
  }

  // Resolve the destination before prompting, so a platform that cannot protect a credential says so
  // before asking someone to type one.
  const location = configLocation(dependencies.environment, dependencies.platform);

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
    writeLine(streams.err, forTerminal(endpoint.message));
    return EXIT_USAGE;
  }

  const rejection = inspectApiKey(key);
  if (rejection !== undefined) {
    writeLine(streams.err, describeKeyRejection(rejection.reason, rejection.limit, 'That key'));
    return EXIT_USAGE;
  }

  const config = { endpoint: endpoint.base, apiKey: key };
  const result = await verify(transportFor(config));
  if (!result.ok) {
    writeLine(streams.err, 'Could not verify that connection, so nothing was saved.');
    return reportFailure(streams, result.failure);
  }

  const outcome = saveConfig(location, config);

  if (asJson) {
    writeJson(streams.out, {
      endpoint: endpoint.base,
      protocolVersion: result.value.protocolVersion,
      configFile: outcome.file,
      durabilityUnconfirmed: outcome.durabilityUnconfirmed,
    });
  } else if (outcome.durabilityUnconfirmed) {
    // The credential on disk is the new one. Saying "login failed" here would be false, and rolling
    // back would discard a verified connection to protect against a power cut that may not come.
    writeLine(
      streams.err,
      `Configuration replaced at ${outcome.file}, but crash durability could not be confirmed. ` +
        'The new credential is in place and usable; if this machine loses power before the filesystem ' +
        'flushes, the change may not survive. Run "raphael login" again if that happens.',
    );
  } else {
    writeLine(streams.out, `Connected to ${forTerminal(endpoint.base)}.`);
    writeLine(streams.out, `Saved to ${outcome.file}.`);
  }

  return outcome.durabilityUnconfirmed ? EXIT_FAILURE : EXIT_OK;
};
