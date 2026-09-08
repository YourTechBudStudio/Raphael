import clsx from 'clsx';
import { Text } from 'react-native';

export interface CardTextProps {
  children: string;
  className?: string | undefined;
}

/** The title line of a resource card: Sora 20, the same on every kind. */
export function CardTitle({ children, className }: CardTextProps) {
  return (
    <Text className={clsx('font-heading text-[20px] leading-[26px] text-ink', className)}>
      {children}
    </Text>
  );
}

/** The one or two lines under a card title. */
export function CardSummary({ children, className }: CardTextProps) {
  return (
    <Text className={clsx('font-body text-[16px] leading-[22px] text-ink', className)}>
      {children}
    </Text>
  );
}
