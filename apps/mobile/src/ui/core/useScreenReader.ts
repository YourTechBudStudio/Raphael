import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether a screen reader is driving this device right now.
 *
 * It exists for layouts whose visual arrangement and traversal order cannot both be right. React
 * Native exposes no cross-platform way to tell the platform what order to read a view tree in -
 * iOS's `accessibilityElements` and Android's `accessibilityTraversalBefore` are both absent from
 * the core props - so a layout that places cards anywhere other than source order is read in an
 * order that does not match what is on the screen. The only honest lever left is to choose a
 * different arrangement when someone is listening rather than looking.
 *
 * Defaults to false and corrects itself on the first answer, so nothing waits on the query, and it
 * follows the setting being turned on or off while the app is open.
 */
export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let live = true;

    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (live) setEnabled(on);
    });

    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);

    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
