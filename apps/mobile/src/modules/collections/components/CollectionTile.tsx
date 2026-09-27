import clsx from 'clsx';
import { ChevronRight } from 'lucide-react-native';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Card, Emblem, type EmblemName, colors } from '../../../ui';

export interface CollectionTileProps {
  name: string;
  emblem: EmblemName;
  /** Shown under the name on the taller tile the boards use when there is room. */
  description?: string | undefined;
  onPress: () => void;
  waveSeed?: number | undefined;
  className?: string | undefined;
  /** Layout for the outer element, which does not scale when the tile is pressed. */
  style?: StyleProp<ViewStyle> | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/**
 * The tile that stands for an area or a project on a board: emblem, name, an optional description,
 * and a chevron into it. Used for the Subareas and Projects sections, so both stay identical. Flat
 * lists - Search and Favorites - use `ListRow` instead.
 */
export function CollectionTile({
  name,
  emblem,
  description,
  onPress,
  waveSeed = 0,
  className,
  style,
  accessibilityHint,
  testID,
}: CollectionTileProps) {
  const hasDescription = description !== undefined && description !== '';

  return (
    <Card
      accessibilityHint={accessibilityHint ?? `Opens ${name}`}
      accessibilityLabel={name}
      className={clsx('justify-center px-4 py-3', hasDescription && 'pb-6', className)}
      onPress={onPress}
      style={style}
      testID={testID}
      wave
      waveHeight={hasDescription ? 56 : 40}
      waveSeed={waveSeed}
    >
      <View className={clsx('flex-row gap-3', hasDescription ? 'items-start' : 'items-center')}>
        <Emblem name={emblem} size={36} />
        <View className="flex-1">
          <View className="min-h-11 flex-row items-center gap-2">
            <Text
              className="flex-1 font-heading text-[17px] leading-[22px] text-ink"
              numberOfLines={1}
            >
              {name}
            </Text>
            <ChevronRight color={colors.ink} size={22} strokeWidth={2} />
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
