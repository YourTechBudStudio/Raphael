import type { LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { colors } from '../theme';

export interface StatePillProps {
  icon: LucideIcon;
  /** The state in one word, such as "Archived". Passed in: `ui` holds no product wording. */
  label: string;
  testID?: string | undefined;
}

/**
 * A small state marker beside a name: an icon and a word on the primary-soft surface.
 *
 * The word is there so the state is never carried by color alone. Not announced on its own: the
 * control it sits in says the state in its own spoken label, and a second voice would repeat it.
 */
export function StatePill({ icon: Icon, label, testID }: StatePillProps) {
  return (
    <View
      accessibilityElementsHidden
      className="flex-row items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5"
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Icon color={colors.primary} size={13} strokeWidth={2} />
      <Text className="font-body-medium text-[13px] text-primary">{label}</Text>
    </View>
  );
}
