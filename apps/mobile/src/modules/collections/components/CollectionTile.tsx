import clsx from 'clsx';
import { ChevronRight } from 'lucide-react-native';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Card, Emblem, type EmblemName, FavoriteButton, colors } from '../../../ui';

/** The screen-reader action that stands in for the star nested inside the tile's press surface. */
const TOGGLE_FAVORITE_ACTION = 'toggleFavorite';

/** What sits at the end of the row: a chevron into the collection, or its favorite star. */
export type CollectionTileTrailing = 'chevron' | 'favorite' | 'none';

export interface CollectionTileProps {
  name: string;
  /** Zero allows the whole name to wrap in full-width lists. */
  nameNumberOfLines?: number | undefined;
  /** Tight vertical spacing for shortcut lists rather than feature cards. */
  compact?: boolean | undefined;
  emblem: EmblemName;
  /** Shown under the name on the taller tile the boards use when there is room. */
  description?: string | undefined;
  onPress: () => void;
  trailing?: CollectionTileTrailing | undefined;
  /** Required when `trailing` is `favorite`. */
  favorited?: boolean | undefined;
  onToggleFavorite?: (() => void) | undefined;
  waveSeed?: number | undefined;
  className?: string | undefined;
  /** Layout for the outer element, which does not scale when the tile is pressed. */
  style?: StyleProp<ViewStyle> | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/**
 * The tile that stands for an area or a project: emblem, name, an optional description,
 * and either a chevron or the favorite star. Used for favorites, subareas, projects, and
 * collection search results, so all four stay identical.
 */
export function CollectionTile({
  name,
  nameNumberOfLines = 1,
  compact = false,
  emblem,
  description,
  onPress,
  trailing = 'chevron',
  favorited = false,
  onToggleFavorite,
  waveSeed = 0,
  className,
  style,
  accessibilityHint,
  testID,
}: CollectionTileProps) {
  const hasDescription = description !== undefined && description !== '';
  // The star sits inside the tile's own press surface, so a screen reader merges it into the
  // tile. The toggle is offered as an action on the tile instead, and the tile says whether it
  // is starred, so favoriting stays operable without sight.
  const showsFavorite = trailing === 'favorite' && onToggleFavorite !== undefined;

  return (
    <Card
      accessibilityActions={
        showsFavorite
          ? [
              {
                name: TOGGLE_FAVORITE_ACTION,
                label: favorited ? `Remove ${name} from favorites` : `Add ${name} to favorites`,
              },
            ]
          : undefined
      }
      accessibilityHint={accessibilityHint ?? `Opens ${name}`}
      accessibilityLabel={name}
      accessibilityValue={
        showsFavorite ? { text: favorited ? 'Starred' : 'Not starred' } : undefined
      }
      className={clsx(
        'justify-center',
        compact ? 'px-3 py-1' : 'px-4 py-3',
        hasDescription && !compact && 'pb-6',
        className,
      )}
      onAccessibilityAction={
        showsFavorite
          ? (event) => {
              if (event.nativeEvent.actionName === TOGGLE_FAVORITE_ACTION) {
                onToggleFavorite();
              }
            }
          : undefined
      }
      onPress={onPress}
      style={style}
      testID={testID}
      wave
      waveHeight={compact ? 16 : hasDescription ? 56 : 40}
      waveSeed={waveSeed}
    >
      <View className={clsx('flex-row gap-3', hasDescription ? 'items-start' : 'items-center')}>
        <Emblem name={emblem} size={compact ? 24 : 36} />
        <View className="flex-1">
          <View className="min-h-11 flex-row items-center gap-2">
            <Text
              className={clsx(
                'flex-1 text-ink',
                compact
                  ? 'font-body-semibold text-[16px] leading-[22px]'
                  : 'font-heading text-[17px] leading-[22px]',
              )}
              numberOfLines={nameNumberOfLines}
            >
              {name}
            </Text>
            {trailing === 'chevron' ? (
              <ChevronRight color={colors.ink} size={22} strokeWidth={2} />
            ) : null}
            {showsFavorite ? (
              <FavoriteButton favorited={favorited} label={name} onToggle={onToggleFavorite} />
            ) : null}
          </View>
          {hasDescription ? (
            <Text className="mt-1 font-body text-[15px] leading-[21px] text-ink-soft">
              {description}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
