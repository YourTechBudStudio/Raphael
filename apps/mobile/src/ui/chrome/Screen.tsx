import type { ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, gutter } from '../theme';

/**
 * Clearance under the scroll content so the floating capture bar never covers the last card:
 * the 56 pill plus the space it floats in.
 */
const CAPTURE_BAR_CLEARANCE = 120;
/** How close to the bottom, in logical pixels, counts as reaching the end. */
const END_THRESHOLD = 480;

export interface ScreenProps {
  children: ReactNode;
  /** Top bar, drawn inside the safe area and above the scrolling content. */
  header?: ReactNode | undefined;
  /** Extra bottom padding on top of the capture bar clearance. */
  extraBottomPadding?: number | undefined;
  /** Set false on screens with no capture bar, to drop its clearance. */
  captureBar?: boolean | undefined;
  /** Called as the scroll nears the end, for a body that can load more. */
  onEndReached?: (() => void) | undefined;
  /** Pull down to reload what the screen shows. `refreshing` keeps the indicator up meanwhile. */
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  className?: string | undefined;
  contentContainerStyle?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/**
 * The screen frame: canvas background, safe-area aware, a fixed header slot and a scrolling
 * body on the 20px gutter. Taps reach buttons while the keyboard is up, and scrolling the
 * body puts the keyboard away.
 */
export function Screen({
  children,
  header,
  extraBottomPadding = 0,
  captureBar = true,
  onEndReached,
  onRefresh,
  refreshing = false,
  className,
  contentContainerStyle,
  testID,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const bottomClearance = captureBar ? CAPTURE_BAR_CLEARANCE : 24;

  return (
    <View className={['flex-1 bg-canvas', className ?? ''].join(' ')} testID={testID}>
      {header === undefined ? null : (
        <View style={{ paddingHorizontal: gutter, paddingTop: insets.top + 8 }}>{header}</View>
      )}
      <ScrollView
        contentContainerStyle={[
          {
            paddingHorizontal: gutter,
            paddingTop: header === undefined ? insets.top + 8 : 16,
            paddingBottom: insets.bottom + bottomClearance + extraBottomPadding,
          },
          contentContainerStyle,
        ]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={
          onEndReached === undefined
            ? undefined
            : (event: NativeSyntheticEvent<NativeScrollEvent>) => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                if (
                  contentOffset.y + layoutMeasurement.height >=
                  contentSize.height - END_THRESHOLD
                ) {
                  onEndReached();
                }
              }
        }
        refreshControl={
          onRefresh === undefined ? undefined : (
            <RefreshControl
              colors={[colors.primary]}
              onRefresh={onRefresh}
              refreshing={refreshing}
              tintColor={colors.primary}
            />
          )
        }
        scrollEventThrottle={onEndReached === undefined ? undefined : 64}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}
