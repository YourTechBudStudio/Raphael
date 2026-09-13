import { create } from 'zustand';

import type { PendingAttempt } from '../../../infrastructure/api/contracts';

interface PendingState {
  /** Attempts closed while their outcome was unknown, oldest first. */
  attempts: readonly PendingAttempt[];
  keep: (attempt: PendingAttempt) => void;
  resolve: (attemptKey: string) => void;
}

/**
 * Unresolved creation attempts, in memory.
 *
 * In memory is a mock-phase limitation, not the design: an attempt that outlives the app has to
 * outlive the process, and phase 09 owns writing these somewhere durable. What is settled here
 * is the shape and the rule: an attempt is kept exactly as it was sent, and resolved only by a
 * definite answer about that key.
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
