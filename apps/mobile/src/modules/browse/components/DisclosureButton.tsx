import { ChevronRight } from 'lucide-react-native';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { PressableFeedback, colors } from '../../../ui';

/** Soft and quick, so the chevron settles well under the row's own press feedback. */
const ROTATION_SPRING = { damping: 15, stiffness: 300 } as const;
/** The tap target; the drawn circle is smaller, as on the navigation boards. */
const TARGET = 44;
const CIRCLE = 34;
/** The tap target centres the drawn circle; the animated surface itself is circle-sized. */
const CENTERED_TARGET = {
  alignItems: 'center',
  height: TARGET,
  justifyContent: 'center',
  width: TARGET,
} as const;

export interface DisclosureButtonProps {
  expanded: boolean;
  /** Name of the node, so the spoken label reads "Expand Creative work". */
  name: string;
  onPress: () => void;
  /**
   * False while the tree is filtered and every branch is open regardless of its stored state:
   * the chevron still shows the branch is open, but it is not offered as a control it cannot be.
   */
  interactive?: boolean | undefined;
  testID?: string | undefined;
}

/** The chevron that opens a branch: points right when closed, down when open. */
export function DisclosureButton({
  expanded,
  name,
  onPress,
  interactive = true,
  testID,
}: DisclosureButtonProps) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(expanded ? 90 : 0);

  useEffect(() => {
    const target = expanded ? 90 : 0;
    rotation.value = reducedMotion ? target : withSpring(target, ROTATION_SPRING);
  }, [expanded, reducedMotion, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const circle = (
    <View
      className="items-center justify-center rounded-full border border-line bg-canvas"
      style={{ height: CIRCLE, width: CIRCLE }}
    >
      <Animated.View style={chevronStyle}>
        <ChevronRight color={colors.ink} size={18} strokeWidth={2} />
      </Animated.View>
    </View>
  );

  if (!interactive) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={CENTERED_TARGET}
      >
        {circle}
      </View>
    );
  }

  return (
    <PressableFeedback
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={CENTERED_TARGET}
      testID={testID}
    >
      {circle}
    </PressableFeedback>
  );
}
