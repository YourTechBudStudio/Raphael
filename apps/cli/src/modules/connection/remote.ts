/**
 * Deciding which server a remote command talks to, and with what key.
 *
 * Two sources, and the rule between them is **both or neither**. `RAPHAEL_ENDPOINT` and
 * `RAPHAEL_API_KEY` override the saved configuration as a *unit*; if either is set, both must be set
 * and usable. Sources are never combined, so an environment override always names its own
 * destination and a key from one place is never sent to an address from another.
 *
 * An empty variable counts as unset, which is how `VAR= raphael …` reads in a shell. (The server is
 * different on purpose: there an empty value overrides `.env` and is reported, because a server
 * variable is set once for a long-running process rather than per command.)
 *
 * Everything that can be checked without a request is checked here, and every refusal names its
 * source: the address must parse and the key must be one a header can carry (`isSendableApiKey`).
 *
 * There is no `.env` loading here. That is a server-startup convenience; a remote command silently
 * picking up a credential from whatever directory it happens to be run in is not one.
 */

import {
  DEFAULT_TIMEOUT_MS,
  createTransport,
  isTransportRejection,
  type FetchLike,
  type Transport,
  type TransportRejection,
} from '@raphael/client';
import { SENDABLE_API_KEY_RULE, hasApiKey, isSendableApiKey } from '@raphael/contracts/connection';

import type { Connected, ConnectionInfo } from '../../shared/command.ts';
import { forTerminal } from '../../shared/output.ts';
import { TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS } from '../../shared/timeout.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE,
  SERVER_API_KEY_VARIABLE,
  TIMEOUT_VARIABLE,
} from '../../shared/variables.ts';
import { ConfigError, configLocation, loadConfig, type StoredConfig } from './config.ts';
import { checkEndpoint, isEndpointProblem } from './endpoint.ts';

export { TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS } from '../../shared/timeout.ts';

export const ENDPOINT_VARIABLE = CLIENT_ENDPOINT_VARIABLE;
export const API_KEY_VARIABLE = CLIENT_API_KEY_VARIABLE;
export { TIMEOUT_VARIABLE };

export type ConnectionSource = ConnectionInfo['source'];

export interface RemoteConnection {
  readonly config: StoredConfig;
  readonly source: ConnectionSource;
  /** The saved login's file; null for the environment. */
  readonly configFile: string | null;
}

/**
 * Why a connection could not be set up: a partial environment pair, a key no header can carry, or a
 * transport that refused.
 */
export type ConnectionReason =
  | 'incomplete_environment'
  | 'api_key_unsendable'
  | TransportRejection['reason'];

export class ConnectionError extends Error {
  readonly reason: ConnectionReason;
  /** The one next step, when this failure has a more specific one than its reason's. */
  readonly hint: string | undefined;
  constructor(reason: ConnectionReason, message: string, hint?: string) {
    super(message);
    this.name = 'ConnectionError';
    this.reason = reason;
    this.hint = hint;
  }
}

/** A variable's value, with an empty one read as unset. */
const valueOf = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const value = environment[name];
  return value === undefined || value === '' ? undefined : value;
};

/**
 * What the environment pair says about the saved login, for commands that change it: `both` overrides
 * it, one half alone stops every remote command, and `none` leaves it in charge.
 */
export const environmentPair = (
  environment: Readonly<Record<string, string | undefined>>,
): 'both' | 'endpoint_only' | 'key_only' | 'none' => {
  const endpoint = valueOf(environment, CLIENT_ENDPOINT_VARIABLE) !== undefined;
  const key = valueOf(environment, CLIENT_API_KEY_VARIABLE) !== undefined;
  return endpoint && key ? 'both' : endpoint ? 'endpoint_only' : key ? 'key_only' : 'none';
};

/** The sentence for an environment pair that is not `none`, about a saved login at `endpoint`. */
export const environmentPairNote = (
  pair: Exclude<ReturnType<typeof environmentPair>, 'none'>,
  ending: string,
): string =>
  pair === 'both'
    ? `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} are set in this environment and take precedence over the saved login. ${ending}`
    : `${pair === 'endpoint_only' ? CLIENT_ENDPOINT_VARIABLE : CLIENT_API_KEY_VARIABLE} is set without ` +
      `${pair === 'endpoint_only' ? CLIENT_API_KEY_VARIABLE : CLIENT_ENDPOINT_VARIABLE}, so remote commands ` +
      'here refuse to run until you unset it or set both.';

/** Check a resolved pair before anything is sent, naming its source in every refusal. */
const checked = (
  config: StoredConfig,
  source: ConnectionSource,
  configFile: string | null,
): RemoteConnection => {
  const addressSubject =
    source === 'environment'
      ? CLIENT_ENDPOINT_VARIABLE
      : `The address saved in ${forTerminal(configFile ?? '')}`;
  const endpoint = checkEndpoint(config.endpoint);
  if (isEndpointProblem(endpoint)) {
    throw new ConnectionError(
      endpoint.reason,
      `${addressSubject} is not a usable address: ${endpoint.why}.`,
      source === 'environment'
        ? endpoint.fix
        : `Run "raphael login" again with the right address. ${endpoint.fix}`,
    );
  }
  if (!hasApiKey(config.apiKey)) {
    throw new ConnectionError(
      'api_key_missing',
      `The saved login at ${forTerminal(configFile ?? '')} has no API key.`,
      'Run "raphael login" again to replace it.',
    );
  }
  if (!isSendableApiKey(config.apiKey)) {
    throw new ConnectionError(
      'api_key_unsendable',
      source === 'environment'
        ? `${CLIENT_API_KEY_VARIABLE} has characters that cannot be sent: a key must be ${SENDABLE_API_KEY_RULE}.`
        : `The API key saved in ${forTerminal(configFile ?? '')} has characters that cannot be sent: a key must be ${SENDABLE_API_KEY_RULE}.`,
      source === 'environment'
        ? `Set ${CLIENT_API_KEY_VARIABLE} to the server's ${SERVER_API_KEY_VARIABLE}, exactly.`
        : `Run "raphael login" again with the server's ${SERVER_API_KEY_VARIABLE}.`,
    );
  }
  return { config: { endpoint: endpoint.base, apiKey: config.apiKey }, source, configFile };
};

/**
 * Resolve where to connect.
 *
 * A partial environment pair is an error rather than a fall-through to the saved configuration: the
 * operator clearly intended to point somewhere, and quietly using a different destination than the
 * one they were setting up is the worst available answer.
 */
export const resolveConnection = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): RemoteConnection => {
  const endpoint = valueOf(environment, CLIENT_ENDPOINT_VARIABLE);
  const apiKey = valueOf(environment, CLIENT_API_KEY_VARIABLE);

  if (endpoint === undefined && apiKey !== undefined) {
    throw new ConnectionError(
      'incomplete_environment',
      `${CLIENT_API_KEY_VARIABLE} is set but ${CLIENT_ENDPOINT_VARIABLE} is not. Raphael will not ` +
        'combine a key from the environment with a saved address.',
      `Set ${CLIENT_ENDPOINT_VARIABLE} too, or unset ${CLIENT_API_KEY_VARIABLE} to use your saved ` +
        `login. A server reads its own key from ${SERVER_API_KEY_VARIABLE}.`,
    );
  }
  if (endpoint !== undefined && apiKey === undefined) {
    throw new ConnectionError(
      'incomplete_environment',
      `${CLIENT_ENDPOINT_VARIABLE} is set but ${CLIENT_API_KEY_VARIABLE} is not.`,
      `Set ${CLIENT_API_KEY_VARIABLE} too, or unset ${CLIENT_ENDPOINT_VARIABLE} to use your saved login.`,
    );
  }
  if (endpoint !== undefined && apiKey !== undefined) {
    return checked({ endpoint, apiKey }, 'environment', null);
  }

  const location = configLocation(environment, platform);
  return checked(loadConfig(location), 'saved_login', location.file);
};

/**
 * Build the transport for a remote command.
 *
 * Node's global `fetch` is passed explicitly rather than relied upon inside the client, which is what
 * keeps the client free to run where there is no global fetch worth using.
 */
export const transportFor = (config: StoredConfig, timeoutMs?: number): Transport => {
  const built = createTransport({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    fetch: fetch as unknown as FetchLike,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (isTransportRejection(built)) {
    throw new ConnectionError(built.reason, built.message);
  }
  return built;
};

/**
 * The transport a remote command uses: resolve where to connect, then build the transport for it,
 * keeping what it is connected to so failures can name the endpoint and its source.
 *
 * Exported so the entry point and the tests that run the CLI against a real server compose these two
 * steps once rather than each restating them.
 */
export const connectFrom = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
): Connected => {
  const timeoutMs = timeoutFrom(environment);
  const resolved = resolveConnection(environment, platform);
  const transport = transportFor(resolved.config, timeoutMs);
  return {
    transport,
    connection: {
      endpoint: transport.endpoint.base,
      source: resolved.source,
      configFile: resolved.configFile,
    },
  };
};

/**
 * `RAPHAEL_TIMEOUT`, in whole seconds, bounds the whole exchange of one request. Unset or empty means
 * the client's default. Anything else that is not a whole number in range is refused rather than
 * clamped: a timeout that quietly became a different one is a wait nobody asked for.
 */
export const timeoutFrom = (
  environment: Readonly<Record<string, string | undefined>>,
): number | undefined => {
  const raw = environment[TIMEOUT_VARIABLE];
  if (raw === undefined || raw === '') return undefined;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= TIMEOUT_MIN_SECONDS && seconds <= TIMEOUT_MAX_SECONDS)) {
    throw new ConnectionError(
      'timeout_out_of_range',
      `${TIMEOUT_VARIABLE} must be a whole number of seconds from ${TIMEOUT_MIN_SECONDS} to ` +
        `${TIMEOUT_MAX_SECONDS}. Got "${raw}".`,
      `Set ${TIMEOUT_VARIABLE} to a value in that range, or unset it to wait the default ` +
        `${DEFAULT_TIMEOUT_MS / 1000} seconds.`,
    );
  }
  return seconds * 1000;
};

export { ConfigError };
