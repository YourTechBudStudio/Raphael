/**
 * The title is as large as it can be within two lines, and never smaller than a heading.
 *
 * Two lines is held by the header's `numberOfLines`, not by this function: a 200-code-point title -
 * the longest the contracts accept - fits two lines at no step, and the floor is where a heading
 * stops shrinking. What is checked here is the size, including at the text sizes people actually
 * read at, which is the part that is arithmetic rather than something you can only see by holding a
 * phone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerTitleType, TITLE_MAX_LINES } from './container-title.ts';

/** A 360pt phone less the 20pt gutters, which is the case the steps were chosen for. */
const PHONE = 320;

/** The longest title the contracts accept. `TITLE_MAX_CODE_POINTS` in `nodes/fields.ts`. */
const LONGEST_TITLE = 'x'.repeat(200);

const fits = (title, track, { fontSize }, scale = 1) =>
  title.length * fontSize * 0.55 * scale <= track * TITLE_MAX_LINES;

describe('the container title size', () => {
  it('keeps the full 40px heading for an ordinary area name', () => {
    assert.deepEqual(containerTitleType('Design', PHONE), { fontSize: 40, lineHeight: 48 });
    assert.deepEqual(containerTitleType('Creative work', PHONE), { fontSize: 40, lineHeight: 48 });
  });

  it('steps down rather than taking a third line', () => {
    const long = containerTitleType('Health, fitness and everything physical', PHONE);
    assert.ok(long.fontSize < 40, 'a five-word title must not stay at 40px');
    assert.ok(fits('Health, fitness and everything physical', PHONE, long));
  });

  it('never goes below the floor, however long the title is', () => {
    const absurd = containerTitleType('x'.repeat(400), PHONE);
    assert.deepEqual(absurd, { fontSize: 26, lineHeight: 32 });
  });

  it('gives a wider screen the larger step for the same title', () => {
    const title = 'Health, fitness and everything physical';
    const narrow = containerTitleType(title, PHONE);
    const wide = containerTitleType(title, 700);
    assert.ok(wide.fontSize >= narrow.fontSize);
  });

  it('picks the largest step that fits, or the floor when none does', () => {
    for (const title of ['Design', 'Creative work', 'Rebrand the docs', 'x'.repeat(60)]) {
      const chosen = containerTitleType(title, PHONE);
      // Past a certain length nothing fits two lines, and the floor is the answer rather than a
      // size that keeps shrinking. Either way, no *larger* step may have fitted.
      assert.ok(
        fits(title, PHONE, chosen) || chosen.fontSize === 26,
        `${title} took ${String(chosen.fontSize)}px without fitting, and that is not the floor`,
      );
      for (const bigger of [40, 32].filter((size) => size > chosen.fontSize)) {
        assert.ok(
          !fits(title, PHONE, { fontSize: bigger }),
          `${title} should have taken ${String(bigger)}px`,
        );
      }
    }
  });

  it('falls back to the floor when there is no track to measure against', () => {
    assert.deepEqual(containerTitleType('Design', 0), { fontSize: 26, lineHeight: 32 });
  });

  it('steps down for someone reading at a larger text size', () => {
    const title = 'Home and garden things';
    // The same title on the same phone. At 1.5x each glyph is half again as wide, so the step that
    // fitted at ordinary size does not, and choosing it would be choosing it for the one person it
    // cannot work for.
    const ordinary = containerTitleType(title, PHONE);
    const large = containerTitleType(title, PHONE, 1.5);

    assert.ok(large.fontSize < ordinary.fontSize, 'a larger text size must not keep the same step');
    assert.ok(fits(title, PHONE, large, 1.5) || large.fontSize === 26);
  });

  it('leaves an ordinary name alone however large the text is set', () => {
    // Stepping down is for titles that would not fit, not a tax on having accessible text on.
    assert.deepEqual(containerTitleType('Design', PHONE, 2), { fontSize: 40, lineHeight: 48 });
  });

  it('reads an unusable font scale as ordinary text', () => {
    assert.deepEqual(
      containerTitleType('Creative work', PHONE, 0),
      containerTitleType('Creative work', PHONE),
    );
  });

  it('takes the longest title the contracts allow down to the floor, and no further', () => {
    // It does not fit two lines at 26px and cannot: the header cuts it off there. What this pins is
    // that the answer is a heading rather than a size that keeps shrinking to chase the text.
    assert.deepEqual(containerTitleType(LONGEST_TITLE, PHONE), { fontSize: 26, lineHeight: 32 });
    assert.deepEqual(containerTitleType(LONGEST_TITLE, PHONE, 2), { fontSize: 26, lineHeight: 32 });
  });
});
