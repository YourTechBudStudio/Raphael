import { create } from 'zustand';

interface PlaybackState {
  /** Id of the voice resource currently playing, or null when nothing is playing. */
  playingId: string | null;
  /** Id of the resource holding a paused position, or null. */
  pausedId: string | null;
  /** Whole seconds elapsed in the current playback. */
  elapsedSeconds: number;
  /** Duration of the active resource, so views can compute progress. */
  durationSeconds: number;
  /** Starts a note, or resumes it when it was the one paused. */
  play: (id: string, durationSeconds: number) => void;
  /** Keeps the position so the same note resumes where it stopped. */
  pause: () => void;
  /** Clears playback entirely. */
  stop: () => void;
}

// The store owns the single mock timer, so only one voice note ticks at a time.
let ticker: ReturnType<typeof setInterval> | null = null;

const clearTicker = (): void => {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
};

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  playingId: null,
  pausedId: null,
  elapsedSeconds: 0,
  durationSeconds: 0,
  play: (id, durationSeconds) => {
    clearTicker();

    const state = get();
    const resumeAt = state.pausedId === id ? state.elapsedSeconds : 0;

    set({
      playingId: id,
      pausedId: null,
      durationSeconds,
      elapsedSeconds: resumeAt >= durationSeconds ? 0 : resumeAt,
    });

    ticker = setInterval(() => {
      const current = get();

      if (current.playingId === null) {
        clearTicker();

        return;
      }

      const next = current.elapsedSeconds + 1;

      if (next >= current.durationSeconds) {
        clearTicker();
        set({ playingId: null, pausedId: null, elapsedSeconds: 0, durationSeconds: 0 });

        return;
      }

      set({ elapsedSeconds: next });
    }, 1000);
  },
  pause: () => {
    clearTicker();
    set((state) => ({ playingId: null, pausedId: state.playingId }));
  },
  stop: () => {
    clearTicker();
    set({ playingId: null, pausedId: null, elapsedSeconds: 0, durationSeconds: 0 });
  },
}));
