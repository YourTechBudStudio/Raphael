/** Bars shown while recording: a fixed rail that fills from the right as levels arrive. */
export const LIVE_BAR_COUNT = 40;
/** Bars kept with the saved note, matching the 24 to 32 values every other voice note carries. */
export const SAVED_BAR_COUNT = 28;

/**
 * The live rail. The window is fixed so the row never reflows: before the take fills it, the
 * missing bars sit at zero on the left.
 */
export function liveBars(samples: readonly number[]): number[] {
  const visible = samples.slice(-LIVE_BAR_COUNT);
  const padding = Array.from({ length: LIVE_BAR_COUNT - visible.length }, () => 0);

  return [...padding, ...visible];
}

/**
 * The shape kept with the note: the whole take resampled to a fixed number of bars and scaled
 * so its loudest moment reaches the top, the way the fixture waveforms read.
 */
export function savedWaveform(samples: readonly number[]): number[] {
  if (samples.length === 0) {
    return Array.from({ length: SAVED_BAR_COUNT }, () => 0.2);
  }

  const buckets = Array.from({ length: SAVED_BAR_COUNT }, (_unused, index) => {
    const start = Math.floor((index * samples.length) / SAVED_BAR_COUNT);
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / SAVED_BAR_COUNT));
    const slice = samples.slice(start, end);
    const total = slice.reduce((sum, value) => sum + value, 0);

    return total / slice.length;
  });

  const peak = Math.max(...buckets);

  if (peak <= 0) {
    return buckets;
  }

  return buckets.map((value) => Math.min(1, Number((value / peak).toFixed(2))));
}
