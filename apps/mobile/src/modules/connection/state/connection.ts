/**
 * The app's one connection store, wired to real storage, the real transport, and the real cache.
 *
 * Everything interesting is in `transition.ts`, which takes its platform through ports and so can
 * be driven by a test. This file is the wiring, and it is deliberately the only place in the
 * capability where the keychain, the fetch implementation, and the query cache meet.
 */

import { createTransportPort, forgetLocalContent, retireCaches } from '../client/ports.ts';
import { newConnectionId } from './record.ts';
import { securePort } from './secure-port.ts';
import { createConnectionStorage } from './storage.ts';
import { createConnectionStore, type ConnectionSession } from './transition.ts';

export const useConnectionStore = createConnectionStore({
  storage: createConnectionStorage(securePort),
  createTransport: createTransportPort,
  retireCaches,
  forgetLocalContent,
  newConnectionId,
  now: () => new Date().toISOString(),
});

/** The active session, or null. The one thing other capabilities need from this module. */
export const useConnectionSession = (): ConnectionSession | null =>
  useConnectionStore((state) => (state.phase.kind === 'active' ? state.phase.session : null));

export type {
  Connection,
  ConnectionPhase,
  ConnectionSession,
  DisconnectOutcome,
  EstablishOutcome,
  Rejection,
  StorageState,
} from './transition.ts';
