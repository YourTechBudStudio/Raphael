import { colors } from '../theme';

/**
 * The two state marks, as closed outlines in a 24 × 24 view box.
 *
 * Each is drawn twice - once as the visible stroke, once as the clipping mask the bloom expands
 * inside - so the path and the colors that go with it live together rather than being restated at
 * every control that draws one. `FavoriteButton` on a tile and the labelled toggles on the Area and
 * Project screens are the same mark in different clothes, and this is what keeps them the same mark.
 */
export interface ToggleMark {
  /** Closed outline in a 24 × 24 view box. */
  readonly path: string;
  /** The little drops thrown outward as the mark fills. */
  readonly dropColor: string;
  /** The stroke before it is selected. */
  readonly inactiveColor: string;
}

/** Gold, because a favourite is warm and nothing else on these screens is. */
const GOLD_DROP = '#d99a24';

/** Lucide Star. */
export const FAVORITE_MARK: ToggleMark = {
  path: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
  dropColor: GOLD_DROP,
  inactiveColor: colors.ink,
};

/** Lucide Zap: a fillable energy cue for a project currently being worked on. */
export const ACTIVE_MARK: ToggleMark = {
  path: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z',
  dropColor: colors.primary,
  inactiveColor: colors.inkSoft,
};
