import { colors, type ColorName } from '../theme';

/**
 * Reads a palette token for the places a Tailwind class cannot reach: SVG fills and
 * strokes, lucide `color` props, and shadow definitions.
 *
 * This resolves against `src/ui/theme.ts` rather than uniwind's `useCSSVariable`.
 * `useCSSVariable` returns `string | number | undefined`, so every SVG or icon call site
 * would need a cast and an undefined fallback; the theme mirror is typed, total, and
 * synchronous. `global.css` stays the source of truth for both.
 */
export function useThemeColor(name: ColorName): string {
  return colors[name];
}
