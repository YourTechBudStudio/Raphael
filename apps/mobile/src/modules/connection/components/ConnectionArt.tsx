/**
 * The phone, the server and the thread between them. The offline screen and the change-server
 * screen both draw it, so the two tell one story: broken when the server is away, dotted while a
 * new one is checked, solid once it answers.
 */

import { Server, Smartphone } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { colors, lobedPath } from '../../../ui';

const MARK = 56;

function PhoneMark() {
  return (
    <View className="items-center justify-center" style={{ height: MARK, width: MARK }}>
      <View
        className="absolute inset-0 rounded-[18px] border border-peach bg-card-warm"
        style={{ transform: [{ rotate: '-6deg' }] }}
      />
      <Smartphone color={colors.primary} size={22} strokeWidth={1.9} />
    </View>
  );
}

function ServerMark({ faint }: { faint: boolean }) {
  return (
    <View
      className={['items-center justify-center', faint ? 'opacity-50' : ''].join(' ')}
      style={{ height: MARK, width: MARK }}
    >
      <View className="absolute inset-0" style={{ transform: [{ rotate: '8deg' }] }}>
        <Svg height={MARK} width={MARK}>
          <Path d={lobedPath(MARK, 9, 0.07)} fill={colors.wave} />
        </Svg>
      </View>
      <Server color={colors.lilacDeep} size={21} strokeWidth={1.9} />
    </View>
  );
}

function Dashes() {
  // Overlong on purpose: the canvas clips it to whatever length the thread is given.
  return (
    <Svg height={4} width="100%">
      <Path
        d="M2 2 H2000"
        stroke={colors.lilac}
        strokeDasharray="1 7"
        strokeLinecap="round"
        strokeWidth={3}
      />
    </Svg>
  );
}

/** A dot that travels a segment while work is in flight, and is absent at rest. */
function useTravel(active: boolean, span: number) {
  const reducedMotion = useReducedMotion();
  const travel = useSharedValue(0);

  useEffect(() => {
    if (!active || reducedMotion || span === 0) {
      cancelAnimation(travel);
      travel.value = 0;
      return;
    }
    travel.value = 0;
    travel.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(travel);
    };
  }, [active, reducedMotion, span, travel]);

  return useAnimatedStyle(() => ({
    opacity: active ? 1 - travel.value ** 3 : 0,
    transform: [{ translateX: travel.value * Math.max(span - 8, 0) }],
  }));
}

/**
 * - `broken`: the server did not answer. Two loose ends in the middle.
 * - `open`: nothing is known yet. One faint dotted line.
 * - `joined`: the server answered. One solid violet line.
 */
export type ThreadMode = 'broken' | 'open' | 'joined';

function Thread({ mode, travelling }: { mode: ThreadMode; travelling: boolean }) {
  const [span, setSpan] = useState(0);
  const dot = useTravel(travelling && mode !== 'joined', span);

  if (mode === 'joined') {
    return (
      <View className="flex-1 px-1">
        <View className="h-[3px] rounded-full bg-primary" />
      </View>
    );
  }

  const travelled = (
    <View
      className="flex-1 justify-center"
      onLayout={(event) => {
        setSpan(event.nativeEvent.layout.width);
      }}
    >
      <Dashes />
      <Animated.View className="absolute left-0 h-2 w-2 rounded-full bg-primary" style={dot} />
    </View>
  );

  if (mode === 'open') return <View className="flex-1 flex-row items-center">{travelled}</View>;

  return (
    <View className="flex-1 flex-row items-center">
      {travelled}
      {/* The break: two loose ends, a little out of line with each other. */}
      <View className="w-7 flex-row items-center justify-between px-0.5">
        <View className="h-[7px] w-[7px] -translate-y-[3px] rounded-full bg-lilac" />
        <View className="h-[7px] w-[7px] translate-y-[3px] rounded-full bg-lilac" />
      </View>
      <View className="flex-1 justify-center opacity-50">
        <Dashes />
      </View>
    </View>
  );
}

export interface ConnectionArtProps {
  mode: ThreadMode;
  travelling: boolean;
}

/** Phone, thread, server: a small centred illustration. Decorative; the words carry the meaning. */
export function ConnectionArt({ mode, travelling }: ConnectionArtProps) {
  return (
    <View
      accessibilityElementsHidden
      className="flex-row items-center gap-2 self-center"
      importantForAccessibility="no-hide-descendants"
      style={{ width: 240 }}
    >
      <PhoneMark />
      <Thread mode={mode} travelling={travelling} />
      <ServerMark faint={mode === 'open' && !travelling} />
    </View>
  );
}
