/**
 * `raphael login`: prove the connection works, then and only then write the credential down.
 *
 * The ordering is the whole design. Check that the credential could be kept at all, validate the
 * address locally, read the key without echoing it, check the key's shape locally, make an
 * authenticated request, confirm the answer is a Raphael server speaking a protocol we understand -
 * and only after all of that touch the filesystem. A login that saved first and verified afterwards
 * would leave a broken credential in place on failure, which is worse than not having tried.
 *
 * A key is never accepted as a command-line argument. It would land in shell history and in the
 * process table for every user on the machine. It is typed at a prompt that does not echo it, or
 * piped in with `--api-key-stdin` (the `docker login --password-stdin` pattern), and nothing else.
 */

import { createInterface } from 'node:readline';

import type { Transport } from '@raphael/client';
import { verify } from '@raphael/client/connection';
import { SENDABLE_API_KEY_RULE, isSendableApiKey } from '@raphael/contracts/connection';

import { UsageError, booleanOption, parseArgs } from '../../shared/args.ts';
import {
  observedTransport,
  optionsFor,
  type CommandDefinition,
  type Session,
} from '../../shared/command.ts';
import { EXIT_USAGE, type ExitCode } from '../../shared/exit.ts';
import { describeClientFailure, renderFailure } from '../../shared/failure.ts';
import { Cancelled } from '../../shared/interrupt.ts';
import { forTerminal, type Streams } from '../../shared/output.ts';
import { readStandardInput } from '../../shared/stdin.ts';
import { renderSuccess, type Warning } from '../../shared/success.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE,
  SERVER_API_KEY_VARIABLE,
} from '../../shared/variables.ts';
import { checkConfigDestination, configLocation, saveConfig, savedEndpoint } from './config.ts';
import { checkEndpoint, isEndpointProblem, shownAddress } from './endpoint.ts';
import { environmentPair, environmentPairNote, timeoutFrom, transportFor } from './remote.ts';

/** A key is a line; this is far more than any key and bounds what a mistaken pipe can supply. */
export const API_KEY_STDIN_MAX_BYTES = 64 * 1024;

const PIPED_EXAMPLE = `printf '%s\\n' "$KEY" | raphael login http://127.0.0.1:3000 --api-key-stdin`;

export const LOGIN_DEFINITION: CommandDefinition = {
  name: 'login',
  summary: 'Save a verified server address and API key on this machine.',
  group: 'Setup',
  writes: false,
  usage: ['raphael login [<address>] [--api-key-stdin] [--json]'],
  behavior: [
    'Verifies the address and key with the server, then saves them with owner-only permissions. Nothing is saved unless the server accepted them.',
    `The address is the server's root, such as http://127.0.0.1:3000. The key is the server's ${SERVER_API_KEY_VARIABLE}.`,
    'Without an address argument, prompts for it. The key is read from a prompt that does not show it, or with --api-key-stdin from standard input. It is never taken as an argument.',
    'Saved to $XDG_CONFIG_HOME/raphael/config.json, or ~/.config/raphael/config.json. Logging in again replaces it and says so.',
    `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE}, when both are set, override the saved login; login warns when they are set.`,
    'Prompts go to standard error. Cancelling exits 2 and saves nothing.',
  ],
  constraints: [
    '--api-key-stdin needs the address as an argument, and standard input must not be a terminal.',
    `The key on standard input is everything up to the end, with one trailing newline removed. It must be ${SENDABLE_API_KEY_RULE}, on one line.`,
  ],
  options: [
    {
      name: 'api-key-stdin',
      type: 'boolean',
      description: 'Read the key from standard input instead of prompting.',
    },
    { name: 'json', type: 'boolean', description: 'Print the result as one JSON document.' },
    { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' },
  ],
  examples: [
    { argv: ['login'], description: 'Prompt for the address and the key.' },
    { argv: ['login', 'http://127.0.0.1:3000'], description: 'Prompt for the key only.' },
    {
      argv: ['login', 'http://127.0.0.1:3000', '--api-key-stdin', '--json'],
      description: `Read the key from a pipe, as in: ${PIPED_EXAMPLE}`,
    },
  ],
  prints:
    'The verified address and the saved file. JSON has endpoint, protocolVersion, configFile and replaced (the previous address, or null).',
  next: 'raphael status',
  seeAlso: ['connecting'],
  fieldFlags: {},
};

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
      'Logging in without a terminal needs the address and --api-key-stdin, as in: ' +
        `${PIPED_EXAMPLE}. Or set ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} instead.`,
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
      rl.once('close', () =>
        reject(new Cancelled('Cancelled. Nothing was saved.', 'raphael login')),
      );
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
          `Use --api-key-stdin, or set ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} instead.`,
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
              reject(new Cancelled('Cancelled. Nothing was saved.', 'raphael login'));
              return;
            case 0x04: // Ctrl-D at an empty prompt ends input.
              if (entered === '') {
                restore();
                process.stderr.write('\n');
                reject(new Cancelled('No key was entered. Nothing was saved.', 'raphael login'));
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
  readonly transport?: (
    config: { readonly endpoint: string; readonly apiKey: string },
    timeoutMs: number | undefined,
  ) => Transport;
  readonly prompter: () => Prompter;
  /** Standard input for `--api-key-stdin`: whether it is a terminal, and its bytes. */
  readonly stdin?: { readonly isTTY: boolean; readonly read: () => Promise<Buffer> };
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

const processStdin = {
  get isTTY(): boolean {
    return process.stdin.isTTY === true;
  },
  read: (): Promise<Buffer> =>
    readStandardInput({
      limit: API_KEY_STDIN_MAX_BYTES,
      tooLarge: () =>
        new UsageError(
          `The key on standard input is longer than ${API_KEY_STDIN_MAX_BYTES} bytes. Nothing was saved.`,
          'login',
        ),
    }),
};

/** A key from standard input: everything, with exactly one trailing newline removed. */
const keyFromStdin = (bytes: Buffer): string => bytes.toString('latin1').replace(/\r?\n$/u, '');

/** A local refusal at login: nothing was sent and nothing was saved. */
const refused = (
  dependencies: LoginDependencies,
  code: string,
  message: string,
  hint: string,
): ExitCode =>
  renderFailure(dependencies.streams, dependencies.session, {
    code,
    exitCode: EXIT_USAGE,
    message: `${message} Nothing was saved.`,
    hint,
    state: 'not_sent',
    fromServer: false,
  });

export const runLogin = async (
  argv: readonly string[],
  dependencies: LoginDependencies,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(LOGIN_DEFINITION), 'login');
  const { streams } = dependencies;

  if (parsed.positionals.length > 1) {
    throw new UsageError(
      `"login" takes one address. Got ${parsed.positionals.length} arguments.`,
      'login',
    );
  }
  const addressArgument = parsed.positionals[0];
  const fromStdin = booleanOption(parsed, 'api-key-stdin');
  const stdin = dependencies.stdin ?? processStdin;
  if (fromStdin && addressArgument === undefined) {
    throw new UsageError(
      `--api-key-stdin needs the address as an argument, as in: ${PIPED_EXAMPLE}.`,
      'login',
    );
  }
  if (fromStdin && stdin.isTTY) {
    throw new UsageError(
      '--api-key-stdin reads the key from a pipe, and standard input is a terminal here, where the ' +
        'key would be shown. Leave out --api-key-stdin to be asked for it without it being shown.',
      'login',
    );
  }

  // Check where the credential will go, and the timeout, before anyone types a key: a directory that
  // cannot protect a credential is reported now rather than after the key was entered and verified.
  const location = configLocation(dependencies.environment, dependencies.platform);
  checkConfigDestination(location);
  const timeoutMs = timeoutFrom(dependencies.environment);

  // The address is checked as soon as it is known, before the key is read: someone who mistyped the
  // address should not type a key first, and a pipe should not be waited on for nothing.
  const addressProblem = (input: string): ExitCode | undefined => {
    const checked = checkEndpoint(input);
    if (!isEndpointProblem(checked)) return undefined;
    const shown = shownAddress(input);
    return refused(
      dependencies,
      checked.reason,
      `${shown === undefined ? 'That address is not usable' : `"${shown}" is not a usable address`}: ${checked.why}.`,
      `${checked.fix.replace(/\.$/u, '')}, then run "raphael login" again.`,
    );
  };

  let endpointInput: string;
  let key: string;
  if (addressArgument !== undefined) {
    endpointInput = addressArgument.trim();
    const problem = addressProblem(endpointInput);
    if (problem !== undefined) return problem;
  }
  if (fromStdin) {
    endpointInput = (addressArgument ?? '').trim();
    key = keyFromStdin(await stdin.read());
  } else {
    const prompter = dependencies.prompter();
    try {
      if (addressArgument === undefined) {
        endpointInput = (await prompter.ask('Server address: ')).trim();
        const problem = addressProblem(endpointInput);
        if (problem !== undefined) return problem;
      } else {
        endpointInput = addressArgument.trim();
      }
      key = await prompter.askHidden('API key: ');
    } finally {
      prompter.close();
    }
  }

  const endpoint = checkEndpoint(endpointInput);
  // Checked above; this narrows the type.
  if (isEndpointProblem(endpoint)) return addressProblem(endpointInput) ?? EXIT_USAGE;

  const keySource = fromStdin ? 'The key on standard input' : 'The key';
  if (key === '') {
    return refused(
      dependencies,
      'api_key_missing',
      fromStdin ? 'Standard input had no key.' : 'No key was entered.',
      `Give the server's ${SERVER_API_KEY_VARIABLE}, then run "raphael login" again.`,
    );
  }
  if (!isSendableApiKey(key)) {
    return refused(
      dependencies,
      'api_key_unsendable',
      `${keySource} has characters that cannot be sent: a key must be ${SENDABLE_API_KEY_RULE}, on one line.`,
      `Give the server's ${SERVER_API_KEY_VARIABLE} exactly, on one line.`,
    );
  }

  const config = { endpoint: endpoint.base, apiKey: key };
  const result = await verify(
    observedTransport(
      dependencies.session,
      (dependencies.transport ?? transportFor)(config, timeoutMs),
    ),
  );
  if (!result.ok) {
    const failure = describeClientFailure(dependencies.session, result.failure);
    return renderFailure(streams, dependencies.session, {
      ...failure,
      message: `${failure.message} Nothing was saved.`,
    });
  }

  const previous = savedEndpoint(location);
  const outcome = (dependencies.save ?? saveConfig)(location, config);
  const replaced = previous !== undefined && previous !== endpoint.base ? previous : null;

  // The credential on disk is the new one even when its durability could not be confirmed. Saying
  // "login failed" would be false, and rolling back would discard a verified connection to protect
  // against a power cut that may not come; so it succeeds, with a warning.
  const warnings: Warning[] = [];
  if (outcome.durabilityUnconfirmed) {
    warnings.push({
      code: 'durability_unconfirmed',
      message:
        `Saved to ${outcome.file}, but the filesystem did not confirm the write is durable. ` +
        'If this machine loses power soon, run "raphael login" again.',
    });
  }
  const pair = environmentPair(dependencies.environment);
  if (pair !== 'none') {
    warnings.push({
      code: 'environment_overrides',
      message: environmentPairNote(pair, `Unset them to use ${forTerminal(endpoint.base)}.`),
    });
  }

  return renderSuccess(streams, dependencies.session, {
    data: {
      endpoint: endpoint.base,
      protocolVersion: result.value.protocolVersion,
      configFile: outcome.file,
      replaced,
    },
    lines: () => [`Connected to ${forTerminal(endpoint.base)}.`, `Saved to ${outcome.file}.`],
    notes: replaced === null ? [] : [`Replaced the saved login for ${forTerminal(replaced)}.`],
    warnings,
  });
};
