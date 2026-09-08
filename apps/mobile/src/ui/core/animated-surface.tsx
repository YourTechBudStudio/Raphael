import Animated from 'react-native-reanimated';
import { withUniwind } from 'uniwind';

/**
 * `Animated.View` with Tailwind classes. Reanimated's own view does not understand
 * `className`, so every animated surface in the design system uses this instead.
 */
export const AnimatedSurface = withUniwind(Animated.View);
