/** Formats whole seconds as `m:ss`, the way every voice card and the recorder read time. */
export function formatDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
