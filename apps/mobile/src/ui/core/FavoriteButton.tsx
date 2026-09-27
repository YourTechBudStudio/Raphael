import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { BloomIcon } from './BloomIcon';
import { BusyRing } from './BusyRing';
import { FAVORITE_MARK } from './toggle-marks';

/** The button's box, which is also its touch target and the ring's size. */
const STAR_BOX = 44;

export interface FavoriteButtonProps {
  favorited: boolean;
  onToggle: () => void;
  /** Name of the thing being favorited, so the spoken label stays specific. */
  label: string;
  size?: number | undefined;
  /** A change is in flight: the ring turns and nothing can be pressed. */
  busy?: boolean | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/**
 * A violet bloom, tiny tilt-and-rebound, and golden drops. Reduced motion is immediate.
 *
 * The bare mark, for places that name the thing some other way - a tile already carries the title
 * the star belongs to. Where the star needs its own word, use `ToggleLabel` with the same mark.
 *
 * While `busy`, it dims and cannot be pressed, and the `BusyRing` turns around the mark, the way
 * `ArchiveIconToggle` draws it. The mark keeps showing the state being written, so what is on
 * screen during the wait is true. The ring is centred on the button's 44-point box rather than on
 * whatever width the button was laid out at, so it circles the mark in any row.
 */
export function FavoriteButton({
  favorited,
  onToggle,
  label,
  size = 24,
  busy = false,
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
      accessibilityState={{ busy, checked: favorited, disabled: busy, selected: favorited }}
      className={[
        'h-11 w-11 items-center justify-center',
        busy ? 'opacity-60' : '',
        className ?? '',
      ].join(' ')}
      disabled={busy}
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
      {busy ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View style={{ height: STAR_BOX, width: STAR_BOX }}>
            <BusyRing size={STAR_BOX} />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}
