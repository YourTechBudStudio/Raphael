/**
 * How big a container's title is allowed to be.
 *
 * A 40px Sora title has about 320px to work in on a phone, which is roughly twelve characters a
 * line: "Creative work" already wraps to two. An area called "Health, fitness and everything
 * physical" runs to four, and a header that tall costs more than the whole block is worth on a
 * screen people mostly pass through on their way somewhere else.
 *
 * So the type steps down instead of wrapping forever. The size is chosen from the title's length,
 * not measured from a rendered line: `adjustsFontSizeToFit` shrinks after laying out, which flickers
 * on Android, changes with the platform font scale, and cannot be asserted in a test. This is a pure
 * function of a string and two numbers, so it can be.
 *
 * The estimate is deliberately crude. Being one line out chooses a slightly smaller size, which is
 * still a legible heading; the alternative - measuring - buys precision the design does not need.
 *
 * Stepping down is how the title *stays* readable; it is not what keeps the header short. Titles
 * may be 200 code points, and nothing below 26px is a heading, so a long enough title does not fit
 * two lines at any step. The header cuts it off at `TITLE_MAX_LINES` and announces the whole of it
 * to a screen reader, which is the bound this file's promise actually rests on.
 */

/** Sora at weight 600, average advance as a fraction of the font size. */
const AVERAGE_ADVANCE = 0.55;

/**
 * Past this the title steps down rather than taking another line, and at the floor it is cut off.
 *
 * The component renders with `numberOfLines`, so this is the height of the header rather than a
 * hope about it. The estimate below decides how much of a title is legible before that cut; it does
 * not decide whether the cut happens.
 */
export const TITLE_MAX_LINES = 2;

export interface TitleType {
  readonly fontSize: number;
  readonly lineHeight: number;
}

/** Largest first. The last is the floor: below it a heading stops reading as one. */
const TITLE_STEPS: readonly TitleType[] = [
  { fontSize: 40, lineHeight: 48 },
  { fontSize: 32, lineHeight: 38 },
  { fontSize: 26, lineHeight: 32 },
];

const SMALLEST = TITLE_STEPS[TITLE_STEPS.length - 1] ?? { fontSize: 26, lineHeight: 32 };

/**
 * The largest step whose estimated wrap fits `TITLE_MAX_LINES` in `trackWidth` logical pixels.
 *
 * `trackWidth` is what the title actually gets - the screen less its gutters - so a wider phone
 * keeps the big heading on a title a narrow one has to step down.
 *
 * `fontScale` is the platform text-size setting, and it is part of the arithmetic rather than a
 * detail left to the renderer: the text is drawn at `fontSize * fontScale`, so someone reading at
 * 1.5x gets half again as many characters per line as this would otherwise assume. Ignoring it
 * would step down only for the people who never needed it and never for the people who do.
 */
export function containerTitleType(title: string, trackWidth: number, fontScale = 1): TitleType {
  if (trackWidth <= 0) return SMALLEST;

  // A platform that reports nothing usable is read as ordinary text rather than as a reason to
  // shrink a heading no one asked to shrink.
  const scale = fontScale > 0 ? fontScale : 1;

  return (
    TITLE_STEPS.find(
      (step) =>
        title.length * step.fontSize * scale * AVERAGE_ADVANCE <= trackWidth * TITLE_MAX_LINES,
    ) ?? SMALLEST
  );
}
