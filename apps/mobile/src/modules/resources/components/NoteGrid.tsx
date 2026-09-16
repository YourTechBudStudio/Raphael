import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { useScreenReader } from '../../../ui';
import type { NoteSummaryItem } from '../client/summary';
import { buildColumnGrid, shouldCollapseColumns, type GridItem } from './layout';
import { NoteCard } from './NoteCard';

/** A note card and a leading card are the same size to the arrangement, and roughly are. */
const NOTE_HEIGHT = 0.9;

/**
 * A card the grid draws before the server's notes.
 *
 * Typed rather than a bare `ReactNode`, because the arrangement needs two things a node cannot
 * supply: a stable key, and a height to balance the columns with. A list of opaque nodes would have
 * to be laid out above the grid instead of leading it, which is not what the design asks for - an
 * unfinished note is a card *in* this grid, first.
 *
 * Phase 06 fills this from capture. Nothing here knows what an unfinished note is.
 */
export interface NoteGridLeadingItem {
  /** Namespaced by its producer, so a draft numbered 12 cannot collide with note 12. */
  readonly key: string;
  /** Defaults to a note card's height. Pass one only for a card of a genuinely different size. */
  readonly height?: number | undefined;
  readonly card: ReactNode;
}

type Cell =
  | { readonly kind: 'note'; readonly note: NoteSummaryItem }
  | { readonly kind: 'leading'; readonly card: ReactNode };

export interface NoteGridProps {
  items: readonly NoteSummaryItem[];
  /** Drawn first, in the order given. */
  leading?: readonly NoteGridLeadingItem[] | undefined;
  /**
   * The title of the container a note sits in, when it is known. Returning undefined is the honest
   * answer while the hierarchy is absent, failed or no longer current.
   */
  locationFor?: ((parentId: number) => string | undefined) | undefined;
  onOpen?: ((id: number) => void) | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/**
 * Home's and a container's notes, in the paired-column arrangement.
 *
 * Two columns become one for three reasons, and `shouldCollapseColumns` holds all of them: scaled-up
 * text, a narrow window, and a screen reader. The first two are about room. The third is about
 * order - the paired arrangement renders the whole left column before the right, so it is walked
 * 1, 3, 2, 4 while the eye reads 1, 2, 3, 4, and stacking is the only layout whose reading order and
 * visual order are guaranteed to agree.
 */
export function NoteGrid({
  items,
  leading,
  locationFor,
  onOpen,
  className,
  testID,
}: NoteGridProps) {
  const { width, fontScale } = useWindowDimensions();
  const screenReader = useScreenReader();
  const stacked = shouldCollapseColumns(width, fontScale, screenReader);

  const cells: GridItem<Cell>[] = [
    ...(leading ?? []).map((item): GridItem<Cell> => ({
      key: item.key,
      height: item.height ?? NOTE_HEIGHT,
      value: { kind: 'leading', card: item.card },
    })),
    ...items.map((note): GridItem<Cell> => ({
      key: `note:${String(note.id)}`,
      height: NOTE_HEIGHT,
      value: { kind: 'note', note },
    })),
  ];

  const draw = (cell: Cell): ReactNode =>
    cell.kind === 'leading' ? (
      cell.card
    ) : (
      <NoteCard
        location={locationFor?.(cell.note.parentId)}
        note={cell.note}
        onOpen={
          onOpen === undefined
            ? undefined
            : () => {
                onOpen(cell.note.id);
              }
        }
        testID={`note-card-${String(cell.note.id)}`}
      />
    );

  // Stacked, every card is its own row, so the order they are rendered in - and therefore the order
  // they are read out in - is the order they were given in.
  if (stacked) {
    return (
      <View className={clsx('gap-4', className)} testID={testID}>
        {cells.map((item) => (
          <View key={item.key}>{draw(item.value)}</View>
        ))}
      </View>
    );
  }

  return (
    <View className={clsx('gap-4', className)} testID={testID}>
      {buildColumnGrid(cells).map((block, blockIndex) =>
        block.kind === 'full' ? (
          <View key={block.item.key}>{draw(block.item.value)}</View>
        ) : (
          <View
            className="flex-row gap-4"
            // Column blocks have no id of their own; their position is their identity.
            key={`columns-${String(blockIndex)}`}
            testID="note-grid-columns"
          >
            {[block.left, block.right].map((column, columnIndex) => (
              <View className="flex-1 gap-4" key={columnIndex === 0 ? 'left' : 'right'}>
                {column.map((item) => (
                  <View key={item.key}>{draw(item.value)}</View>
                ))}
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
}
