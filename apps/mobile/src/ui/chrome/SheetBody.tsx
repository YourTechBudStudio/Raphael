import type { ReactNode } from 'react';
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native';

export interface SheetBodyProps {
  children: ReactNode;
  className?: string | undefined;
  contentContainerStyle?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/**
 * The scrolling middle of a sheet.
 *
 * A sheet surface stops at a fraction of the window height, and content laid out past that edge
 * is clipped — on Android it stops taking touches at all. Landscape, a short screen, and a large
 * text setting all push a sheet past its cap, so whatever can grow goes in here, and the chrome
 * that has to stay reachable — the title row, the dismissal, Save, the recording controls — is
 * pinned to the surface outside it.
 *
 * It takes only the height its content needs until the sheet runs out of room, and scrolls from
 * there. The scroll indicator is left visible: it is the only sign that there is more below.
 */
export function SheetBody({ children, className, contentContainerStyle, testID }: SheetBodyProps) {
  return (
    <ScrollView
      className={className ?? ''}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      style={{ flexShrink: 1 }}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}
