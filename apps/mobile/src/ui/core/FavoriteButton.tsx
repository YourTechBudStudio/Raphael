import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { BloomIcon } from './BloomIcon';

const GOLD_DROP = '#d99a24';
/** The Lucide star outline, shared by the visible stroke and the bloom's clipping mask. */
const STAR_PATH =
  'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z';

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

/** A violet bloom, tiny tilt-and-rebound, and golden drops. Reduced motion is immediate. */
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
      <BloomIcon dropColor={GOLD_DROP} path={STAR_PATH} selected={favorited} size={size} />
    </Pressable>
  );
}
