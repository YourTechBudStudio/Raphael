import type { LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { colors } from '../theme';

export interface EmptyStateProps {
  /** What is missing, said plainly: "No notes here yet." */
  title: string;
  /** One line on what to do about it. Dry humour is welcome here, not in errors. */
  description?: string | undefined;
  icon?: LucideIcon | undefined;
  className?: string | undefined;
  testID?: string | undefined;
}

/** The placeholder for a section that exists but holds nothing yet. */
export function EmptyState({ title, description, icon: Icon, className, testID }: EmptyStateProps) {
  return (
    <View
      className={['gap-2 rounded-card border border-line bg-card px-5 py-6', className ?? ''].join(
        ' ',
      )}
      testID={testID}
    >
      {Icon === undefined ? null : <Icon color={colors.lilac} size={22} strokeWidth={1.9} />}
      <Text className="font-heading text-[17px] text-ink">{title}</Text>
      {description === undefined ? null : (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">{description}</Text>
      )}
    </View>
  );
}
