import clsx from 'clsx';
import { View } from 'react-native';

import type { Resource } from '../../../infrastructure/api/contracts';
import type { CardVariant } from '../../../ui';
import { buildResourceGrid, type ResourceGridItem } from './layout';
import { ResourceCard } from './ResourceCard';

export interface ResourceGridProps {
  items: readonly ResourceGridItem[];
  /** The surface written notes sit on in this grid. Home keeps them warm; a collection uses lilac. */
  noteVariant?: CardVariant | undefined;
  /**
   * What a tap on a card does. Left out, the cards are plain surfaces rather than buttons —
   * there is no resource detail screen in this build, so no board passes this yet.
   */
  onPressResource?: ((resource: Resource) => void) | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/**
 * The mixed grid the boards use: full-width rows for cards that need the room, and pairs
 * of columns for the rest, each card joining whichever column is shorter so the two sides
 * stay level without a masonry library.
 */
export function ResourceGrid({
  items,
  noteVariant = 'warm',
  onPressResource,
  className,
  testID,
}: ResourceGridProps) {
  const blocks = buildResourceGrid(items);
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
              key={block.resource.id}
              layout="full"
              noteVariant={noteVariant}
              onPress={pressHandler?.(block.resource)}
              resource={block.resource}
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
                {column.map((resource) => {
                  seed += 1;

                  return (
                    <ResourceCard
                      key={resource.id}
                      layout="column"
                      noteVariant={noteVariant}
                      onPress={pressHandler?.(resource)}
                      resource={resource}
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
