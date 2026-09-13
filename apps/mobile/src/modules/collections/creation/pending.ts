import { create } from 'zustand';

import type { PendingAttempt } from './types.ts';

interface PendingState {
  /** Attempts closed while their outcome was unknown, oldest first. */
  attempts: readonly PendingAttempt[];
  keep: (attempt: PendingAttempt) => void;
  resolve: (attemptKey: string) => void;
}

/**
 * Unresolved creation attempts, in memory.
 *
 * Nothing in this release renders or writes to this store: phase 08 removed every production path
 * into container creation, and this is kept alongside the reducer as reviewed behaviour phase 09
 * builds on. In memory is a limitation phase 09 owns - an attempt that outlives the app has to
 * outlive the process. What is settled here is the shape and the rule: an attempt is kept exactly
 * as it was sent, and resolved only by a definite answer about that key.
 */
export const usePendingStore = create<PendingState>((set) => ({
  attempts: [],
  keep: (attempt) => {
    set((state) => ({
      attempts: [
        ...state.attempts.filter((existing) => existing.attemptKey !== attempt.attemptKey),
        attempt,
      ],
    }));
  },
  resolve: (attemptKey) => {
    set((state) => ({
      attempts: state.attempts.filter((existing) => existing.attemptKey !== attemptKey),
    }));
  },
}));
