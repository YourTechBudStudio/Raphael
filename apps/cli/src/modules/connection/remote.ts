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
  createTransport,
  isTransportRejection,
  type FetchLike,
  type Transport,
} from '@raphael/client';
import { inspectApiKey } from '@raphael/contracts/connection';

import { ConfigError, configLocation, loadConfig, type StoredConfig } from './config.ts';

export const ENDPOINT_VARIABLE = 'RAPHAEL_ENDPOINT';
export const API_KEY_VARIABLE = 'RAPHAEL_API_KEY';

export type ConnectionSource = 'environment' | 'configuration';

export interface RemoteConnection {
  readonly config: StoredConfig;
  readonly source: ConnectionSource;
}

export class ConnectionError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.reason = reason;
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
        `${API_KEY_VARIABLE} is set but ${ENDPOINT_VARIABLE} is not. Set both, or unset both to use your ` +
          'saved login. Raphael will not combine a key from the environment with a saved address.',
      );
    }
    if (apiKey === undefined || apiKey === '') {
      throw new ConnectionError(
        'incomplete_environment',
        `${ENDPOINT_VARIABLE} is set but ${API_KEY_VARIABLE} is not. Set both, or unset both to use your ` +
          'saved login.',
      );
    }
    const rejection = inspectApiKey(apiKey);
    if (rejection !== undefined) {
      throw new ConnectionError(
        'unusable_environment_key',
        describeKeyRejection(rejection.reason, rejection.limit, API_KEY_VARIABLE),
      );
    }
    return { config: { endpoint, apiKey }, source: 'environment' };
  }

  const config = loadConfig(configLocation(environment, platform));
  return { config, source: 'configuration' };
};

/** Shared wording for a key that cannot be used, whatever handed it to us. */
export const describeKeyRejection = (
  reason: 'empty' | 'unusable_characters' | 'too_short',
  limit: number | undefined,
  source: string,
): string => {
  switch (reason) {
    case 'empty':
      return `${source} is empty.`;
    case 'unusable_characters':
      return (
        `${source} contains a character that cannot travel in an HTTP header. Keys must be visible ASCII, ` +
        'with no spaces, control characters, or non-ASCII characters. Check for a stray quote or trailing space.'
      );
    case 'too_short':
      return (
        `${source} is shorter than the ${limit ?? 32}-character minimum. Length is not strength - ` +
        `${limit ?? 32} repeated characters would pass this check and still be weak - so generate a random ` +
        'one with "openssl rand -hex 32".'
      );
  }
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

export { ConfigError };
