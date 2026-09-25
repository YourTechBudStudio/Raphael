import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { useScreenReader } from '../../../ui';
import type { NoteSummaryItem } from '../client/summary';
import { buildColumnGrid, shouldCollapseColumns, type GridItem } from './layout';
import { NoteCard } from './NoteCard';

/** Every cell in this grid is a note card, and the arrangement sizes them all alike. */
const NOTE_HEIGHT = 0.9;

/**
 * This grid draws the server's notes and nothing else.
 *
 * It used to take leading cards, for the unfinished notes Home drew before the feed. Home draws no
 * unfinished cards of any kind any more - it carries one count beside the Notes heading and Recovery
 * carries the list - so the mechanism is gone rather than left with no caller.
 */
export interface NoteGridProps {
  items: readonly NoteSummaryItem[];
  /**
   * The title of the container a note sits in, when it is known. Returning undefined is the honest
   * answer while the hierarchy is absent, failed or no longer current.
   */
  locationFor?: ((parentId: number) => string | undefined) | undefined;
  onOpen?: ((id: number) => void) | undefined;
  /** Draw the Archived pill on archived notes. Only Search sets it (`NoteCard`). */
  markArchived?: boolean | undefined;
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
  locationFor,
  onOpen,
  markArchived,
  className,
  testID,
}: NoteGridProps) {
  const { width, fontScale } = useWindowDimensions();
  const screenReader = useScreenReader();
  const stacked = shouldCollapseColumns(width, fontScale, screenReader);

  const cells: GridItem<NoteSummaryItem>[] = items.map((note) => ({
    key: `note:${String(note.id)}`,
    height: NOTE_HEIGHT,
    value: note,
  }));

  const draw = (note: NoteSummaryItem): ReactNode => (
    <NoteCard
      location={locationFor?.(note.parentId)}
      markArchived={markArchived}
      note={note}
      onOpen={
        onOpen === undefined
          ? undefined
          : () => {
              onOpen(note.id);
            }
      }
      testID={`note-card-${String(note.id)}`}
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
