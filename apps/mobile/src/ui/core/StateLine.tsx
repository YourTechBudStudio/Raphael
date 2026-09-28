import { Text } from 'react-native';
import Animated from 'react-native-reanimated';

import { useWaitingPulse } from './waiting-pulse';

const LINE = 'font-body text-[15px] leading-[22px] text-ink-soft';

export interface StateLineProps {
  children: string;
  className?: string | undefined;
}

/**
 * A quiet sentence on the canvas, for states that are not content: empty, no match, ended.
 *
 * Plain soft ink with no card, so every list says "there is nothing here" the same way. Announced
 * politely, because it replaces whatever the list was showing a moment ago.
 */
export function StateLine({ children, className }: StateLineProps) {
  return (
    <Text accessibilityLiveRegion="polite" className={[LINE, className ?? ''].join(' ')}>
      {children}
    </Text>
  );
}

/**
 * A waiting sentence - "Searching…", "Loading more…" - with a slow pulse while the server looks.
 *
 * The pulse is the only motion, and it says work is in flight rather than decorating the wait.
 */
export function WaitingLine({ children }: { children: string }) {
  const pulse = useWaitingPulse();

  return (
    <Animated.Text accessibilityLiveRegion="polite" className={LINE} style={pulse}>
      {children}
    </Animated.Text>
  );
}
