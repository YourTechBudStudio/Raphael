import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { IconButton } from '../core/IconButton';

export interface SheetHeaderProps {
  title: string;
  /** One quiet line under the title: the current path, or what the sheet holds. */
  subtitle?: string | undefined;
  /** Sits before the title block, such as the close X on the New note sheet. */
  leading?: ReactNode | undefined;
  /** Replaces the default close button, such as a Save pill. */
  trailing?: ReactNode | undefined;
  /** Used by the default close button; ignored when `trailing` is given. */
  onClose?: (() => void) | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/** The title row of a sheet: title, optional subtitle, and a dismissal that is always visible. */
export function SheetHeader({
  title,
  subtitle,
  leading,
  trailing,
  onClose,
  className,
  testID,
}: SheetHeaderProps) {
  return (
    <View className={['flex-row items-start gap-3', className ?? ''].join(' ')} testID={testID}>
      {leading === undefined ? null : <View className="pt-1">{leading}</View>}
      <View className="flex-1 gap-1">
        <Text
          accessibilityRole="header"
          className="font-heading text-[28px] leading-[34px] text-ink"
        >
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">{subtitle}</Text>
        )}
      </View>
      {trailing ?? (
        <IconButton className="bg-primary-soft" icon={X} label="Close" onPress={onClose} />
      )}
    </View>
  );
}
