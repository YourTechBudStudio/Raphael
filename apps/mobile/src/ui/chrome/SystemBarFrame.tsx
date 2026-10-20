import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '../theme';

export interface SystemBarFrameProps {
  children: ReactNode;
  /**
   * Paints the band in the canvas colour. The root does; a sheet's modal does not, because it is
   * transparent and the root's band already shows through it, as does the screen the scrim dims.
   */
  paintBand?: boolean | undefined;
}

/**
 * Gives Android's navigation buttons a band of their own, so nothing Raphael draws sits behind them.
 *
 * Android 16 draws every app edge to edge and offers no way out, so the band has to be kept here. The
 * frame pads by the navigation bar natively, and the provider inside measures only the system bars
 * its own frame overlaps. That frame ends above the band, so everything inside reads a bottom inset of
 * zero: no screen, sheet or bar has to know the band exists.
 *
 * Padding, not margin. In a modal's window there is no provider above the frame, so it measures its
 * own overlap with the navigation bar. A margin would move it clear of the bar, measure zero, drop
 * the margin and measure the bar again, without end. Padding leaves its bounds where they are.
 *
 * It is mounted once per window: at the root, and in each sheet's modal, which Android shows in a
 * window of its own. iOS keeps drawing under the home indicator, as its apps do, so there it is
 * nothing.
 */
export function SystemBarFrame({ children, paintBand = false }: SystemBarFrameProps) {
  if (Platform.OS !== 'android') return children;

  return (
    <SafeAreaView
      edges={['bottom']}
      mode="padding"
      style={{ flex: 1, backgroundColor: paintBand ? colors.canvas : undefined }}
    >
      <SafeAreaProvider>{children}</SafeAreaProvider>
    </SafeAreaView>
  );
}
