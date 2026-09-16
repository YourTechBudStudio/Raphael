import clsx from 'clsx';
import { View } from 'react-native';

import type { Resource, ResourceKind } from '../../../infrastructure/api/contracts';
import { buildColumnGrid, type GridItem } from './layout';
import { ResourceCard } from './ResourceCard';

/**
 * Relative heights, used only to decide which column a card joins. Images are tall, a repository
 * link is short; the numbers are ratios, not pixels. The `note` entry is gone with the session-only
 * note: a note is server data drawn by `NoteGrid` now.
 */
const ESTIMATED_HEIGHT: Record<ResourceKind, number> = {
  image: 1.6,
  voice: 1,
  github: 0.8,
};

/** One entry in a media grid. `span: 'full'` forces a full-width row. */
export interface ResourceGridItem {
  resource: Resource;
  span?: 'full' | undefined;
}

export interface ResourceGridProps {
  items: readonly ResourceGridItem[];
  /**
   * What a tap on a card does. Left out, the cards are plain surfaces rather than buttons —
   * there is no detail screen for session media, so no board passes this.
   */
  onPressResource?: ((resource: Resource) => void) | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/**
 * The mixed grid the media sections use: full-width rows for cards that need the room, and pairs
 * of columns for the rest.
 *
 * This now serves session-only media alone. Its arrangement comes from the shared helper, which
 * `NoteGrid` uses too, so the two grids cannot drift into two different ideas of how cards pair up.
 */
export function ResourceGrid({ items, onPressResource, className, testID }: ResourceGridProps) {
  const blocks = buildColumnGrid(
    items.map((item): GridItem<Resource> => ({
      key: `media:${item.resource.id}`,
      height: ESTIMATED_HEIGHT[item.resource.kind],
      ...(item.span === undefined ? {} : { span: item.span }),
      value: item.resource,
    })),
  );
  let seed = 0;

  // A card becomes a button only where the tap has somewhere to go. Manufacturing a handler
  // regardless would give every card press feedback and a button role for a no-op, which reads
  // as a broken control to touch and screen-reader users alike.
  const pressHandler =
    onPressResource === undefined
      ? undefined
      : (resource: Resource) => () => {
          onPressResource(resource);
        };

  return (
    <View className={clsx('gap-4', className)} testID={testID}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'full') {
          seed += 1;

          return (
            <ResourceCard
              key={block.item.key}
              layout="full"
              onPress={pressHandler?.(block.item.value)}
              resource={block.item.value}
              waveSeed={seed}
            />
          );
        }

        return (
          <View
            className="flex-row gap-4"
            // Column blocks have no id of their own; their position is their identity.
            key={`columns-${String(blockIndex)}`}
          >
            {[block.left, block.right].map((column, columnIndex) => (
              <View className="flex-1 gap-4" key={columnIndex === 0 ? 'left' : 'right'}>
                {column.map((item) => {
                  seed += 1;

                  return (
                    <ResourceCard
                      key={item.key}
                      layout="column"
                      onPress={pressHandler?.(item.value)}
                      resource={item.value}
                      waveSeed={seed}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}
