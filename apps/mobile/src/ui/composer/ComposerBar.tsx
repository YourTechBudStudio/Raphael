import type { ReactNode } from 'react';
import { View } from 'react-native';

export interface ComposerBarProps {
  /** A row above the bar proper, separated by a rule. The formatting controls sit here. */
  above?: ReactNode | undefined;
  /** The bar itself: one row, laid out by whoever fills it. */
  children: ReactNode;
  testID?: string | undefined;
}

/**
 * The shell of the bar pinned above the keyboard.
 *
 * Only the shell: the rule, the row heights and the horizontal padding. What goes in it - a
 * destination chip alone, or a chip and a Save pill, or a formatting row above both - is the
 * screen's, so that the one thing shared between a read-only note and a note being written is the
 * thing that is actually the same.
 */
export function ComposerBar({ above, children, testID }: ComposerBarProps) {
  return (
    <View testID={testID}>
      {above === undefined ? null : (
        <View className="h-12 justify-center border-b border-line">{above}</View>
      )}
      <View className="flex-row items-center gap-2 px-3 pt-2">{children}</View>
    </View>
  );
}
