import { Text, View } from 'react-native';

import { Chip } from '../../../ui';

export interface PreviewAction {
  label: string;
  onPress: () => void;
}

export interface PreviewPanelProps {
  /** What these controls do, and what they do not. */
  description: string;
  actions: readonly PreviewAction[];
}

/**
 * A development-only way into states the app cannot otherwise reach.
 *
 * There is no server to talk to during UI work, and secure storage does not exist yet, so several
 * states in this phase are unreachable by using the app normally. Reviewing them is the point of a
 * mock-UI phase, so they are put on screen deliberately - and labelled, because a control that
 * fakes a connection must never be mistaken for one that made one.
 *
 * Renders only under `__DEV__`. Phase 09 removes it with the rest of the preview wiring.
 */
export function PreviewPanel({ description, actions }: PreviewPanelProps) {
  if (!__DEV__) return null;

  return (
    <View className="gap-2 rounded-card border border-dashed border-line p-4">
      <Text className="font-body-medium text-[12px] uppercase tracking-[1px] text-ink-soft">
        Preview · development only
      </Text>
      <Text className="font-body text-[14px] leading-[20px] text-ink-soft">{description}</Text>
      <View className="flex-row flex-wrap gap-2 pt-1">
        {actions.map((action) => (
          <Chip key={action.label} label={action.label} onPress={action.onPress} />
        ))}
      </View>
    </View>
  );
}
