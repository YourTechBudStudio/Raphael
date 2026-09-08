import { useEffect, useId, useRef } from 'react';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Path } from 'react-native-svg';

import { colors } from '../theme';
import { AnimatedSurface } from './animated-surface';
import { FEEDBACK_DURATION } from './motion';
const DROP_DIRECTIONS = [
  { x: -0.94, y: -0.34 },
  { x: -0.64, y: -0.77 },
  { x: 0.05, y: -1 },
  { x: 0.7, y: -0.71 },
  { x: 0.98, y: -0.2 },
] as const;
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function Drop({
  phase,
  direction,
  color,
}: {
  phase: SharedValue<number>;
  direction: (typeof DROP_DIRECTIONS)[number];
  color: string;
}) {
  const animatedProps = useAnimatedProps(() => {
    const travel = 1 - (1 - phase.value) ** 2;
    const distance = 10 + travel * 9;
    return {
      cx: 12 + direction.x * distance,
      cy: 12 + direction.y * distance + 2 * phase.value ** 2,
      r: interpolate(phase.value, [0, 0.2, 1], [0.4, 1.2, 0]),
      opacity: interpolate(phase.value, [0, 0.15, 0.55, 1], [0, 1, 1, 0]),
    };
  });

  return <AnimatedCircle animatedProps={animatedProps} fill={color} />;
}

interface BloomIconProps {
  selected: boolean;
  /** Closed outline in a 24 × 24 view box, used for both the stroke and fill mask. */
  path: string;
  size?: number | undefined;
  inactiveColor?: string | undefined;
  dropColor: string;
}

/** Decorative icon only; the owning control supplies semantics and a stable hit area. */
export function BloomIcon({
  selected,
  path,
  size = 24,
  inactiveColor = colors.ink,
  dropColor,
}: BloomIconProps) {
  const reducedMotion = useReducedMotion();
  const id = useId();
  const clipId = `toggle-bloom-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const progress = useSharedValue(selected ? 1 : 0);
  const scale = useSharedValue(1);
  const rotation = useSharedValue(0);
  const burst = useSharedValue(1);
  const previousSelected = useRef(selected);

  // Follow state, including rollback. New targets interrupt the current motion rather
  // than queuing another performance; mounting an already selected icon stays quiet.
  useEffect(() => {
    const changed = previousSelected.current !== selected;
    previousSelected.current = selected;
    const target = selected ? 1 : 0;
    progress.value = reducedMotion
      ? target
      : withTiming(target, { duration: FEEDBACK_DURATION, easing: Easing.out(Easing.cubic) });

    if (reducedMotion) {
      scale.value = 1;
      rotation.value = 0;
      burst.value = 1;
      return;
    }
    if (!changed) {
      return;
    }

    const quick = { duration: 65, easing: Easing.out(Easing.quad) };
    const rebound = { duration: 85, easing: Easing.inOut(Easing.quad) };
    const settle = {
      duration: FEEDBACK_DURATION - quick.duration - rebound.duration,
      easing: Easing.out(Easing.cubic),
    };
    scale.value = withSequence(
      withTiming(selected ? 1.14 : 0.94, quick),
      withTiming(selected ? 0.98 : 1, rebound),
      withTiming(1, settle),
    );
    rotation.value = withSequence(
      withTiming(selected ? -7 : 3, quick),
      withTiming(selected ? 3 : 0, rebound),
      withTiming(0, settle),
    );
    burst.value = selected ? 0 : 1;
    if (selected) {
      burst.value = withTiming(1, { duration: FEEDBACK_DURATION, easing: Easing.linear });
    }
  }, [burst, selected, progress, reducedMotion, rotation, scale]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${rotation.value}deg` }],
  }));

  // Expand from the center, clipped to the outline. The generous final radius covers
  // the tips near the bounce peak (65 ms), without leaving a horizontal fill edge.
  const bloomProps = useAnimatedProps(() => ({
    r: 18 * progress.value,
  }));
  const outlineProps = useAnimatedProps(() => ({
    stroke: interpolateColor(progress.value, [0, 1], [inactiveColor, colors.primary]),
  }));

  return (
    <AnimatedSurface style={[{ width: size, height: size }, iconStyle]}>
      <Svg
        accessible={false}
        height={(size * 40) / 24}
        pointerEvents="none"
        style={{ position: 'absolute', left: -size / 3, top: -size / 3 }}
        viewBox="-8 -8 40 40"
        width={(size * 40) / 24}
      >
        <Defs>
          <ClipPath id={clipId}>
            <Path d={path} />
          </ClipPath>
        </Defs>
        <G clipPath={`url(#${clipId})`}>
          <AnimatedCircle animatedProps={bloomProps} cx={12} cy={12} fill={colors.primary} />
        </G>
        <AnimatedPath
          animatedProps={outlineProps}
          d={path}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
        {DROP_DIRECTIONS.map((direction, index) => (
          <Drop color={dropColor} direction={direction} key={index} phase={burst} />
        ))}
      </Svg>
    </AnimatedSurface>
  );
}
