import { useCallback, useEffect, useRef, useState } from 'react';

/** How often the mock microphone reports a level. */
const SAMPLE_INTERVAL_MS = 100;
/** Recording stops itself here, so a forgotten sheet cannot grow without bound. */
export const MAX_RECORDING_SECONDS = 300;
const MAX_SAMPLES = (MAX_RECORDING_SECONDS * 1000) / SAMPLE_INTERVAL_MS;

const START_LEVEL = 0.45;
const MIN_LEVEL = 0.12;
const MAX_LEVEL = 1;
/** How far one sample can move from the last one: enough to look alive, calm enough to read. */
const DRIFT = 0.34;

/** A soft random walk, so neighbouring bars stay related the way a real voice does. */
function nextAmplitude(previous: number): number {
  const drifted = previous + (Math.random() - 0.5) * DRIFT;
  const pulled = drifted + (START_LEVEL - drifted) * 0.15;

  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, pulled));
}

export type RecorderStatus = 'recording' | 'review';

export interface MockRecorder {
  status: RecorderStatus;
  /** Every level captured so far, oldest first. */
  samples: readonly number[];
  /** Seconds captured, to a tenth. */
  elapsedSeconds: number;
  /** True once the recorder hit its own length limit. */
  atLimit: boolean;
  /** Ends the recording and moves to review. */
  stop: () => void;
  /** Throws the take away and records again from zero. */
  restart: () => void;
}

/**
 * A stand-in for the microphone: while `active`, it appends a level every 100 ms until the
 * caller stops it or it reaches its own limit. The interval is owned here and cleared whenever
 * the recorder stops, the sheet closes, or the component unmounts, so nothing ticks off-screen.
 */
export function useMockRecorder(active: boolean): MockRecorder {
  const [status, setStatus] = useState<RecorderStatus>('recording');
  const [samples, setSamples] = useState<number[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const level = useRef(START_LEVEL);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stopTimer();
    level.current = START_LEVEL;
    setSamples([]);
    setStatus('recording');

    timer.current = setInterval(() => {
      level.current = nextAmplitude(level.current);
      const value = level.current;

      setSamples((previous) => (previous.length >= MAX_SAMPLES ? previous : [...previous, value]));
    }, SAMPLE_INTERVAL_MS);
  }, [stopTimer]);

  const stop = useCallback(() => {
    stopTimer();
    setStatus('review');
  }, [stopTimer]);

  // The sheet drives the recorder: opening it starts a fresh take, closing it stops the clock.
  // The take itself is left alone on the way out, so the sheet does not visibly reset to an empty
  // recording while it animates off screen; the next open clears it.
  useEffect(() => {
    if (!active) {
      stopTimer();

      return;
    }

    start();

    return stopTimer;
  }, [active, start, stopTimer]);

  const atLimit = samples.length >= MAX_SAMPLES;

  // Reaching the limit is the recorder's own decision, so it announces it as a normal stop.
  useEffect(() => {
    if (atLimit && status === 'recording') {
      stop();
    }
  }, [atLimit, status, stop]);

  return {
    status,
    samples,
    elapsedSeconds: (samples.length * SAMPLE_INTERVAL_MS) / 1000,
    atLimit,
    stop,
    restart: start,
  };
}
