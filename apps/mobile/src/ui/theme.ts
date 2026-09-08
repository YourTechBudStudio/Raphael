/**
 * Token values mirrored from `global.css`, for the places Tailwind classes cannot reach:
 * SVG props, icon colors, and shadow definitions.
 *
 * `global.css` is the source of truth. Change it first, then mirror the value here.
 */

export const colors = {
  canvas: '#f8f6fc',
  card: '#f1ecfa',
  cardWarm: '#faf5f2',
  wave: '#e9e1f5',
  waveWarm: '#efe3ea',
  line: '#ded5ef',
  ink: '#24134f',
  inkSoft: '#635580',
  primary: '#5b3fc8',
  primarySoft: '#ebe5fb',
  lilac: '#a18ade',
  lilacDeep: '#7d63d6',
  peach: '#ffd0b8',
  peachDeep: '#f4b596',
  scrim: 'rgba(36, 19, 79, 0.32)',
  onPrimary: '#ffffff',
  danger: '#b3261e',
} as const;

export type ColorName = keyof typeof colors;

export const radii = {
  card: 20,
  tile: 18,
  sheet: 28,
} as const;

export const fonts = {
  heading: 'Sora_600SemiBold',
  headingBold: 'Sora_700Bold',
  body: 'SourceSans3_400Regular',
  bodyMedium: 'SourceSans3_500Medium',
  bodySemibold: 'SourceSans3_600SemiBold',
} as const;

/** Horizontal screen gutter, in logical pixels. */
export const gutter = 20;

/** A token color at partial opacity, for shadows that must follow the palette. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);

  return `rgba(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)}, ${String(alpha)})`;
}

/**
 * `boxShadow` for the floating capture controls: violet, so the pair reads as lifted off the
 * canvas rather than smudged onto it.
 */
export const captureShadow = `0px 10px 22px ${withAlpha(colors.primary, 0.28)}`;

/** `boxShadow` for a sheet: ink, cast upward onto the screen it covers. */
export const sheetShadow = `0px -8px 28px ${withAlpha(colors.ink, 0.18)}`;

/** Soft shadow for floating controls and sheets. */
export const softShadow = {
  shadowColor: colors.ink,
  shadowOpacity: 0.16,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 8,
} as const;
