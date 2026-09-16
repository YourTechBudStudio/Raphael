/**
 * The paired-column arrangement both grids draw, and nothing about what is in them.
 *
 * It used to be written against the session-only `Resource` union and read that union's `kind` to
 * guess a height. Two different things need this arrangement now - server notes and session media -
 * and the union is no longer common to both, so the helper takes what it actually uses: a stable
 * key, a relative height, and whether the item wants the full width. Casting a server summary into
 * the old shape to reach this code would have been a mock-shaped adapter kept alive for a layout
 * calculation.
 *
 * Keys are the caller's, and callers namespace them (`note:12`, `media:voice-3`, `draft:12`). Ids
 * from different sources collide otherwise - a server note numbered 12 and an unfinished draft
 * numbered 12 are not the same card - and React would reuse one's rendered state for the other.
 */

/** `full` is a full-width card; `column` is the narrow card used inside a grid column. */
export type ResourceCardLayout = 'full' | 'column';

/** One entry, as the arrangement sees it. */
export interface GridItem<T> {
  /** Stable and namespaced by whoever produced it. Used as the React key and nothing else. */
  readonly key: string;
  /** Relative, not pixels: only the comparison between two items matters. */
  readonly height: number;
  /** Forces its own full-width row, breaking the column flow. */
  readonly span?: 'full' | undefined;
  readonly value: T;
}

/** A full-width card, or a pair of columns holding the cards between two full rows. */
export type GridBlock<T> =
  | { kind: 'full'; item: GridItem<T> }
  | { kind: 'columns'; left: readonly GridItem<T>[]; right: readonly GridItem<T>[] };

/**
 * Deals items into blocks. Items keep their order: a `full` item breaks the flow into its own row,
 * and everything between two full rows is dealt into two columns, each card joining whichever column
 * is currently shorter so the two sides stay level without a masonry library.
 */
export function buildColumnGrid<T>(items: readonly GridItem<T>[]): GridBlock<T>[] {
  const blocks: GridBlock<T>[] = [];

  let left: GridItem<T>[] = [];
  let right: GridItem<T>[] = [];
  let leftHeight = 0;
  let rightHeight = 0;

  const flushColumns = (): void => {
    if (left.length > 0 || right.length > 0) {
      blocks.push({ kind: 'columns', left, right });
      left = [];
      right = [];
      leftHeight = 0;
      rightHeight = 0;
    }
  };

  for (const item of items) {
    if (item.span === 'full') {
      flushColumns();
      blocks.push({ kind: 'full', item });

      continue;
    }

    if (leftHeight <= rightHeight) {
      left.push(item);
      leftHeight += item.height;
    } else {
      right.push(item);
      rightHeight += item.height;
    }
  }

  flushColumns();

  return blocks;
}

/**
 * Past this text scale the two-column arrangement is abandoned.
 *
 * 1.3 is where a card's title stops fitting two words to a line at half the gutter width on the
 * phones this is drawn on. It is a presentation threshold, not an accessibility setting: someone
 * who has scaled text up gets the same cards in one column, never fewer cards or smaller text.
 */
export const COLUMN_COLLAPSE_FONT_SCALE = 1.3;

/** Below this width there is not room for two cards side by side whatever the text scale. */
export const COLUMN_COLLAPSE_WIDTH = 360;

/**
 * Whether to abandon the two-column arrangement.
 *
 * Two of these reasons are about room: scaled-up text and a narrow window both turn two columns into
 * two columns of one word each.
 *
 * The third is about order, and it is the one that matters most. Cards are dealt into a left and a
 * right column and the left column is rendered in full before the right, so a screen reader walks
 * them 1, 3, 2, 4 while the eye reads 1, 2, 3, 4. React Native offers no cross-platform way to tell
 * the platform otherwise, and the staggered arrangement is a frozen design decision, so the two
 * cannot both be had. Someone listening rather than looking gets a single column, where the order
 * read out and the order on screen are the same list. Nobody gets fewer cards or less information;
 * they get the same cards in an arrangement whose order is unambiguous.
 */
export const shouldCollapseColumns = (
  width: number,
  fontScale: number,
  screenReaderEnabled: boolean,
): boolean =>
  screenReaderEnabled || fontScale >= COLUMN_COLLAPSE_FONT_SCALE || width < COLUMN_COLLAPSE_WIDTH;
