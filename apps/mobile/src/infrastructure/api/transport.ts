/**
 * Building the shared client's transport with this app's chosen fetch.
 *
 * Runtime wiring, not a product decision: what the endpoint and key are, when a transport is
 * built, and how long it stays active all belong to the connection capability. What belongs here
 * is that every transport in this app reads responses through `appFetch` rather than whatever
 * `fetch` happens to be global at the moment it is called.
 */

import { createTransport, isTransportRejection } from '@raphael/client';
import type { Transport, TransportRejection } from '@raphael/client';

import { appFetch } from './fetch';

export type { Transport, TransportRejection };
export { isTransportRejection };

/**
 * A transport for one endpoint and key.
 *
 * The key is captured in the returned transport's closure and is not readable back off it, which
 * is the property the rest of the app relies on: a transport can be held in state, handed to a
 * query function, and compared by identity without the credential being anywhere a screen, a log,
 * or a cache key can reach it.
 */
export const buildTransport = (endpoint: string, apiKey: string): Transport | TransportRejection =>
  createTransport({ endpoint, apiKey, fetch: appFetch });
