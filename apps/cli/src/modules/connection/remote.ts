/**
 * Deciding which server a remote command talks to, and with what key.
 *
 * Two sources, and the rule between them is **both or neither**. `RAPHAEL_ENDPOINT` and
 * `RAPHAEL_API_KEY` override the saved configuration as a *unit*; if either is present, both must be
 * present and usable. Sources are never combined.
 *
 * That rule exists because of a specific hazard. The server reads `RAPHAEL_API_KEY` for its own
 * startup, so a terminal sitting in a server's working directory may well have that variable set. If
 * a key from the environment could combine with an endpoint from the saved configuration, running
 * `raphael get` in that directory would send a local server's key to whatever remote host was
 * configured. Requiring the pair means an environment override always names its own destination.
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

import { TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS } from '../../shared/timeout.ts';
import { ConfigError, configLocation, loadConfig, type StoredConfig } from './config.ts';

export { TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS } from '../../shared/timeout.ts';

export const ENDPOINT_VARIABLE = 'RAPHAEL_ENDPOINT';
export const API_KEY_VARIABLE = 'RAPHAEL_API_KEY';
export const TIMEOUT_VARIABLE = 'RAPHAEL_TIMEOUT';

export type ConnectionSource = 'environment' | 'configuration';

export interface RemoteConnection {
  readonly config: StoredConfig;
  readonly source: ConnectionSource;
}

/** Why a connection could not be set up: a partial environment pair, or a transport that refused. */
export type ConnectionReason = 'incomplete_environment' | TransportRejection['reason'];

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
  const endpoint = environment[ENDPOINT_VARIABLE];
  const apiKey = environment[API_KEY_VARIABLE];
  const anyPresent = endpoint !== undefined || apiKey !== undefined;

  if (anyPresent) {
    if (endpoint === undefined || endpoint === '') {
      throw new ConnectionError(
        'incomplete_environment',
        `${API_KEY_VARIABLE} is set but ${ENDPOINT_VARIABLE} is not. Raphael will not combine a key ` +
          'from the environment with a saved address.',
        `Set ${ENDPOINT_VARIABLE} too, or unset ${API_KEY_VARIABLE} to use your saved login.`,
      );
    }
    if (apiKey === undefined || apiKey === '') {
      throw new ConnectionError(
        'incomplete_environment',
        `${ENDPOINT_VARIABLE} is set but ${API_KEY_VARIABLE} is not.`,
        `Set ${API_KEY_VARIABLE} too, or unset ${ENDPOINT_VARIABLE} to use your saved login.`,
      );
    }
    return { config: { endpoint, apiKey }, source: 'environment' };
  }

  const config = loadConfig(configLocation(environment, platform));
  return { config, source: 'configuration' };
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
 * The transport a remote command uses: resolve where to connect, then build the transport for it.
 *
 * Exported so the entry point and the tests that run the CLI against a real server compose these two
 * steps once rather than each restating them.
 */
export const connectFrom = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
): Transport => {
  const timeoutMs = timeoutFrom(environment);
  return transportFor(resolveConnection(environment, platform).config, timeoutMs);
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
