import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { BloomIcon } from './BloomIcon';
import { FAVORITE_MARK } from './toggle-marks';

export interface FavoriteButtonProps {
  favorited: boolean;
  onToggle: () => void;
  /** Name of the thing being favorited, so the spoken label stays specific. */
  label: string;
  size?: number | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/**
 * A violet bloom, tiny tilt-and-rebound, and golden drops. Reduced motion is immediate.
 *
 * The bare mark, for places that name the thing some other way - a tile already carries the title
 * the star belongs to. Where the star needs its own word, use `ToggleLabel` with the same mark.
 */
export function FavoriteButton({
  favorited,
  onToggle,
  label,
  size = 24,
  className,
  style,
  testID,
}: FavoriteButtonProps) {
  return (
    <Pressable
      accessibilityLabel={
        favorited ? `Remove ${label} from favorites` : `Add ${label} to favorites`
      }
      accessibilityRole="button"
      accessibilityState={{ checked: favorited, selected: favorited }}
      className={['h-11 w-11 items-center justify-center', className ?? ''].join(' ')}
      hitSlop={8}
      onPress={onToggle}
      style={style}
      testID={testID}
    >
      <BloomIcon
        dropColor={FAVORITE_MARK.dropColor}
        path={FAVORITE_MARK.path}
        selected={favorited}
        size={size}
      />
    </Pressable>
  );
}
