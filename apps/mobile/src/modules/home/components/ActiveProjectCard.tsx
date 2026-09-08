import { Text, View } from 'react-native';

import type { Project } from '../../../infrastructure/api/contracts';
import { Card, Emblem, ActiveButton, PressableFeedback } from '../../../ui';
import { openProject } from '../../navigation';

interface ActiveProjectCardProps {
  project: Project;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}

/** Sibling controls keep opening a project and changing active status independently accessible. */
export function ActiveProjectCard({ project, active, disabled, onToggle }: ActiveProjectCardProps) {
  return (
    <Card className="flex-row items-center gap-2 px-3 py-2" wave waveHeight={24}>
      <PressableFeedback
        accessibilityHint="Opens project"
        accessibilityLabel={project.name}
        className="min-h-16 flex-row items-center gap-3 py-2"
        hitSlop={0}
        onPress={() => {
          openProject(project.id);
        }}
        style={{ flex: 1 }}
      >
        <Emblem name={project.emblem} size={32} />
        <View className="flex-1 gap-1">
          <Text className="font-heading text-[18px] leading-[24px] text-ink">{project.name}</Text>
          <Text className="font-body text-[15px] leading-[20px] text-ink-soft">
            {project.description}
          </Text>
        </View>
      </PressableFeedback>
      <ActiveButton disabled={disabled} active={active} label={project.name} onToggle={onToggle} />
    </Card>
  );
}
