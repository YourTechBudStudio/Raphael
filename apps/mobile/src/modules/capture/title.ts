/**
 * What a note's title is: one line, however it arrives, and however large the text is drawn.
 *
 * The design gives the title two visible lines and makes Return move on rather than insert a break.
 * That covers typing and nothing else: a paste, a keyboard macro, or a title recovered from an older
 * build can all carry a line break. So the rule is stated twice, deliberately, at two different
 * boundaries.
 *
 * **In the composer**, arriving breaks are normalized to a space before the owner is told anything,
 * because that is the moment a person can still see and change what happened to their input.
 *
 * **At the freeze boundary**, a title that still holds a break is *refused*, never rewritten. By
 * then the bytes are about to become a frozen request under an idempotency key, and quietly
 * repairing them there would mean the stored request is not what anyone approved - which is the one
 * thing freezing exists to prevent.
 */

/**
 * Every character this app treats as a line break.
 *
 * The two Unicode separators are included because a paste from a word processor carries them and
 * they end a line everywhere it matters. A run of any of them collapses to one space: CRLF is a run
 * of two and must not become two spaces.
 */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/gu;

export const hasLineBreak = (value: string): boolean => /[\r\n\u2028\u2029]/u.test(value);

/**
 * One line, with the authored spacing otherwise untouched.
 *
 * A break becomes a single ordinary space and nothing else changes: no trimming, no collapsing of
 * runs of spaces, no normalization of tabs. Whitespace someone typed is theirs, and the mock's
 * title-tidying is exactly what this phase was told not to port.
 */
export const singleLineTitle = (value: string): string => value.replace(LINE_BREAKS, ' ');

/** The title's declared line height, which the two-line cap is measured in. */
export const TITLE_LINE_HEIGHT = 32;
/** Two lines visible; beyond that the field scrolls within itself. */
export const TITLE_VISIBLE_LINES = 2;
/** Room for the field's own vertical padding, so the second line is not clipped by a pixel. */
const TITLE_PADDING = 8;
/**
 * The scales this cap is willing to follow.
 *
 * Below 1 the field never shrinks, because two lines of small text in a field sized for less would
 * clip the same way the fixed cap did. Above 4 it stops growing, because a title field taller than
 * the screen is not a readable title field - past that point the field's own scrolling is the
 * answer, which is what it is there for.
 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;

/**
 * How tall two lines of the title are at this text scale.
 *
 * A fixed cap was the defect: it is two lines at the default scale and less than two at any larger
 * one, so the second line of a title clipped for exactly the people who had asked for bigger text.
 * Taking the scale from the platform rather than capping it with `maxFontSizeMultiplier` keeps the
 * text the size the person chose and moves the container instead.
 */
export const titleMaxHeight = (fontScale: number): number => {
  const scale = Number.isFinite(fontScale)
    ? Math.min(Math.max(fontScale, MIN_SCALE), MAX_SCALE)
    : MIN_SCALE;

  return TITLE_LINE_HEIGHT * TITLE_VISIBLE_LINES * scale + TITLE_PADDING;
};
