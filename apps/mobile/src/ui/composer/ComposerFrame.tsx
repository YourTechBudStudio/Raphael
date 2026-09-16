import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ComposerFrameProps {
  /** The control at the top left. A close cross on every screen that uses this so far. */
  leading: ReactNode;
  /** The quiet line beside it. `ComposerStatus` draws it; the frame only gives it room. */
  status: ReactNode;
  /** The writing, filling the space between the header and the bar. */
  children: ReactNode;
  /** Pinned above the keyboard. Absent on a screen with nothing to do. */
  bar?: ReactNode | undefined;
  testID?: string | undefined;
}

/**
 * The full-screen writing layout: a close control and a status line at the top, the writing filling
 * the space, and one bar pinned above the keyboard.
 *
 * It is the frame and nothing else. It holds no writing, knows no destination, owns no save and has
 * no opinion about whether what is inside it can be edited - a screen passes in what goes where.
 * That is what lets a note the server holds and a note being written share a layout without sharing
 * behavior, which is the point: they must look like the same screen, because to a person they are.
 *
 * Whether the content scrolls is the content's business. The read-only body is a renderer that
 * scrolls itself, and wrapping it in a scroll view would give it two.
 */
export function ComposerFrame({ leading, status, children, bar, testID }: ComposerFrameProps) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-canvas"
      testID={testID}
    >
      <View className="flex-1">
        <View className="h-14 flex-row items-center px-3" style={{ marginTop: insets.top + 4 }}>
          {leading}
          <View className="ml-1 flex-1">{status}</View>
        </View>

        <View className="flex-1">{children}</View>

        {bar === undefined ? null : (
          <View
            className="border-t border-line bg-card"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            {bar}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
