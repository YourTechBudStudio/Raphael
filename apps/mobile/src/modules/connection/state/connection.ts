import { create } from 'zustand';

/**
 * Whether this device has a server it has actually talked to.
 *
 * Only a verified connection is ever recorded here, mirroring the CLI: validate locally, verify
 * over the network, and only then write anything down. A connection that was typed but not
 * verified does not exist as far as the rest of the app is concerned.
 *
 * The store is in memory, so a relaunch returns to setup. `remembered` is therefore a mock: it
 * says what the screens would be told once a keychain exists, so the "connected but not saved"
 * presentation can be designed and reviewed now. Nothing here writes to a keychain, and no screen
 * may claim durability this store does not have.
 */
export interface Connection {
  /** Origin plus any base path, with no trailing slash. */
  readonly base: string;
  /** For display. Never the key. */
  readonly origin: string;
  readonly protocolVersion: number;
  /**
   * Whether the credential reached this device's secure storage.
   *
   * False is a real outcome, not an error: the connection works for this session and will be gone
   * when the app closes. Fixture-driven until phase 08 wires the keychain.
   */
  readonly remembered: boolean;
}

interface ConnectionState {
  readonly connection: Connection | null;
  readonly connect: (connection: Connection) => void;
  readonly disconnect: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connection: null,
  connect: (connection) => {
    set({ connection });
  },
  disconnect: () => {
    set({ connection: null });
  },
}));
