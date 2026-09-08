import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimatedSurface } from '../core/animated-surface';
import { radii, sheetShadow } from '../theme';

/**
 * One light settle on the way up. The spring travels the full sheet height, so the damping is
 * set for an overshoot of a few logical pixels rather than the ~7% of the height a softer
 * spring would give: the sheet eases through the clamp instead of parking against it.
 */
const ENTER_SPRING = { damping: 24, stiffness: 220, mass: 0.9 } as const;
/** Dismissal is calm: no bounce on the way out. */
const CLOSE_DURATION = 220;
const SCRIM_DURATION = 200;
const REDUCED_MOTION_DURATION = 150;
/** A ceiling on the overshoot, so an unusually tall sheet still travels only a few pixels past. */
const OVERSHOOT_LIMIT = 6;
/** Drag past a quarter of the sheet, or flick it, and it closes. */
const DISMISS_FRACTION = 0.25;
const DISMISS_VELOCITY = 900;
/** Downward travel before the handle takes over, so a tap on it is still a tap. */
const DRAG_ACTIVATION = 8;
/**
 * A sheet never covers more than this share of the screen. The surface clips at that cap, so a
 * host whose content can outgrow it puts that content in a `SheetBody` and pins the rest.
 */
const MAX_HEIGHT_FRACTION = 0.88;

export interface SheetProps {
  /** The host owns the open state; the sheet animates itself in and out around it. */
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Fixed height in logical pixels. Left out, the sheet sizes to its content. */
  snapHeight?: number | undefined;
  /** Wraps the sheet in a KeyboardAvoidingView, for sheets that hold text inputs. */
  keyboardAvoiding?: boolean | undefined;
  /** Classes for the sheet surface, usually padding. */
  className?: string | undefined;
  /** Spoken name of the sheet, for the scrim's close action. */
  label?: string | undefined;
  testID?: string | undefined;
}

/**
 * A bottom sheet: scrim, drag handle, spring entry, and four ways out (handle drag, scrim tap,
 * the host's own close control, and Android back).
 *
 * It renders in a `Modal` rather than an absolute overlay so it also covers stack screens that
 * the platform presents in their own window, such as the Search modal route, and so Android back
 * arrives as `onRequestClose` instead of a global handler that would have to guess who owns it.
 * Gesture handler needs its own root inside that window, so one is mounted here.
 */
export function Sheet({
  visible,
  onClose,
  children,
  snapHeight,
  keyboardAvoiding = false,
  className,
  label,
  testID,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);

  const translateY = useSharedValue(windowHeight);
  const opacity = useSharedValue(0);
  const scrimOpacity = useSharedValue(0);
  const sheetHeight = useSharedValue(windowHeight);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    if (visible) {
      scrimOpacity.value = withTiming(1, { duration: SCRIM_DURATION });
      if (reducedMotion) {
        translateY.value = 0;
        opacity.value = withTiming(1, { duration: REDUCED_MOTION_DURATION });
        return;
      }
      opacity.value = 1;
      translateY.value = sheetHeight.value;
      translateY.value = withSpring(0, ENTER_SPRING);
      return;
    }

    const finish = (finished?: boolean) => {
      'worklet';
      if (finished === true) {
        runOnJS(setMounted)(false);
      }
    };

    scrimOpacity.value = withTiming(0, {
      duration: reducedMotion ? REDUCED_MOTION_DURATION : CLOSE_DURATION,
    });

    if (reducedMotion) {
      opacity.value = withTiming(0, { duration: REDUCED_MOTION_DURATION }, finish);
      return;
    }

    translateY.value = withTiming(
      sheetHeight.value + insets.bottom,
      { duration: CLOSE_DURATION, easing: Easing.out(Easing.cubic) },
      finish,
    );
  }, [
    mounted,
    visible,
    reducedMotion,
    insets.bottom,
    opacity,
    scrimOpacity,
    sheetHeight,
    translateY,
  ]);

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(DRAG_ACTIVATION)
        .onUpdate((event) => {
          translateY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
          const past = translateY.value > sheetHeight.value * DISMISS_FRACTION;
          // The drag asks to close; it does not decide. A host that wants to confirm first
          // keeps `visible` true, so the sheet springs back to rest and waits for the answer
          // instead of parking at the offset the finger left it at. When the host does close,
          // the exit animation takes over from wherever this spring has got to.
          if (past || event.velocityY > DISMISS_VELOCITY) {
            runOnJS(onClose)();
          }
          translateY.value = withSpring(0, ENTER_SPRING);
        }),
    [onClose, sheetHeight, translateY],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: Math.max(translateY.value, -OVERSHOOT_LIMIT) }],
  }));

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));

  const handleLayout = (event: LayoutChangeEvent) => {
    sheetHeight.value = event.nativeEvent.layout.height;
  };

  const surface = (
    <AnimatedSurface
      className={['bg-card', className ?? ''].join(' ')}
      onLayout={handleLayout}
      style={[
        sheetStyle,
        {
          borderTopLeftRadius: radii.sheet,
          borderTopRightRadius: radii.sheet,
          boxShadow: sheetShadow,
          maxHeight: windowHeight * MAX_HEIGHT_FRACTION,
          // With the keyboard up there is less room than the cap allows. Shrinking rather than
          // overflowing keeps the surface inside the window, and a `SheetBody` inside it gives
          // up the space; without one, tall content still runs past the bottom edge.
          flexShrink: 1,
          paddingBottom: insets.bottom + 16 + OVERSHOOT_LIMIT,
          ...(snapHeight === undefined ? {} : { height: snapHeight }),
        },
      ]}
    >
      <GestureDetector gesture={dragGesture}>
        <View accessible={false} className="items-center py-3">
          <View className="h-1 w-10 rounded-full bg-line" />
        </View>
      </GestureDetector>
      {children}
    </AnimatedSurface>
  );

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={onClose}
      statusBarTranslucent
      testID={testID}
      transparent
      visible={mounted}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 justify-end">
          <AnimatedSurface className="absolute inset-0 bg-scrim" style={scrimStyle}>
            <Pressable
              accessibilityHint={label === undefined ? undefined : `Closes ${label}`}
              accessibilityLabel="Close"
              accessibilityRole="button"
              className="flex-1"
              onPress={onClose}
            />
          </AnimatedSurface>
          {keyboardAvoiding ? (
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={{ flexShrink: 1 }}
            >
              {surface}
            </KeyboardAvoidingView>
          ) : (
            surface
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
