import { Text } from 'react-native';

export interface SectionHeadingProps {
  children: string;
  className?: string | undefined;
}

/** Sora 22, the heading above a section of tiles or cards. */
export function SectionHeading({ children, className }: SectionHeadingProps) {
  return (
    <Text
      accessibilityRole="header"
      className={['font-heading text-[22px] leading-[28px] text-ink', className ?? ''].join(' ')}
    >
      {children}
    </Text>
  );
}

export interface EyebrowProps {
  children: string;
  className?: string | undefined;
}

/** The small primary label above a screen title, such as "Area" or "Project". */
export function Eyebrow({ children, className }: EyebrowProps) {
  return (
    <Text className={['font-body-medium text-[16px] text-primary', className ?? ''].join(' ')}>
      {children}
    </Text>
  );
}
