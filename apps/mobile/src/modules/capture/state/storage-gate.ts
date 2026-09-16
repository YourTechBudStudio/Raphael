import { create } from 'zustand';

/**
 * The one fatal local-storage condition the app latches.
 *
 * Two things stop Raphael opening: the draft database cannot be opened or migrated, and a new draft
 * cannot be created. The first is the owner's own `unavailable` status. The second is not a status -
 * the store is open and healthy right up until the insert fails - so it is remembered here, once,
 * and the gate reads it.
 *
 * It latches deliberately. A failure to create a draft is not something the next tap should quietly
 * paper over: the phone could not keep a new note, and a partially working app that offers to write
 * one anyway is the failure mode the gate exists to prevent.
 *
 * What it must **not** catch is an ordinary write failing later, while someone is writing. That
 * leaves the composer exactly where it is, with its unprotected status and its repair sheet, because
 * replacing a live editor with a startup screen would destroy the only copy of what is on it.
 */
interface StorageGateState {
  readonly fatal: boolean;
  latch: () => void;
}

export const useStorageGate = create<StorageGateState>((set) => ({
  fatal: false,
  latch: () => {
    set({ fatal: true });
  },
}));
