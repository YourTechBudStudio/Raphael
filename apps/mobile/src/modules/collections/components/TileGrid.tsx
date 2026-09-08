import clsx from 'clsx';
import { View } from 'react-native';

import { CollectionTile, type CollectionTileProps } from './CollectionTile';

/** One tile in the grid: everything `CollectionTile` needs, plus the key to render it under. */
export type TileGridItem = Pick<
  CollectionTileProps,
  | 'name'
  | 'emblem'
  | 'description'
  | 'onPress'
  | 'accessibilityHint'
  | 'trailing'
  | 'favorited'
  | 'onToggleFavorite'
> & { id: string };

export interface TileGridProps {
  items: readonly TileGridItem[];
  className?: string | undefined;
  testID?: string | undefined;
}

/** Tiles sit two to a row on every board that uses them. */
const PER_ROW = 2;

/**
 * The two-column collection block: Home favorites, and the Subareas and Projects sections on an
 * area. Tiles in a row share the row height, and an odd last tile keeps its column width instead
 * of stretching across, so the grid stays a grid.
 */
export function TileGrid({ items, className, testID }: TileGridProps) {
  const rows: TileGridItem[][] = [];

  for (let index = 0; index < items.length; index += PER_ROW) {
    rows.push(items.slice(index, index + PER_ROW));
  }

  return (
    <View className={clsx('gap-4', className)} testID={testID}>
      {rows.map((row, rowIndex) => (
        <View className="flex-row items-stretch gap-4" key={row.map((item) => item.id).join('-')}>
          {row.map((item, columnIndex) => (
            <CollectionTile
              accessibilityHint={item.accessibilityHint}
              description={item.description}
              emblem={item.emblem}
              favorited={item.favorited}
              key={item.id}
              name={item.name}
              onPress={item.onPress}
              onToggleFavorite={item.onToggleFavorite}
              style={{ flex: 1 }}
              trailing={item.trailing ?? 'chevron'}
              // Neighbouring waves differ so the rows do not look stamped from one template.
              waveSeed={rowIndex * PER_ROW + columnIndex}
            />
          ))}
          {row.length < PER_ROW ? <View className="flex-1" /> : null}
        </View>
      ))}
    </View>
  );
}
