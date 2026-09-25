import { Text, View } from 'react-native';

import { Card, Emblem, emblemFor, ActiveButton, PressableFeedback } from '../../../ui';
import { ActiveVerdict, useProjectActive, type HierarchyNode } from '../../collections';
import { openProject } from '../../navigation';

interface ActiveProjectCardProps {
  project: HierarchyNode;
}

/**
 * One active project, and the control that stops it being one.
 *
 * The card owns its own `useProjectActive()` rather than being handed state by the section. A
 * mutation observer reports only its latest dispatch, so a screen-level instance would lose this
 * card's refusal the moment another card dispatched - and toggles deliberately run independently.
 * Holding the instance here is what lets the sentence below belong to the card that earned it.
 *
 * The node is the write's target as well as what is drawn: it carries the revision this reading was
 * taken at, so the write is guarded against the state the person was actually looking at.
 *
 * Opening and toggling stay sibling controls so both remain independently accessible.
 */
export function ActiveProjectCard({ project }: ActiveProjectCardProps) {
  const active = useProjectActive();
  // A project without a description is the ordinary case, not a tile missing a line. An empty
  // `Text` still occupies a line on Android, so rendering one would hold a gap the card then
  // centres its name against - which reads as a name sitting above the middle of its own card.
  const hasDescription = project.description !== '';
  const disabled = active.isDisabled(project.id);
  // While the write and its re-read are in flight the control is disabled and busy, and that is the
  // whole message: a sentence beside it would explain a state the ring already states.
  const verdict = disabled ? null : active.failure;

  return (
    <Card className="px-3 py-2" wave waveHeight={24}>
      <View className="flex-row items-center gap-2">
        <PressableFeedback
          accessibilityHint="Opens project"
          accessibilityLabel={project.title}
          className="min-h-16 flex-row items-center gap-3 py-2"
          hitSlop={0}
          onPress={() => {
            openProject(project.id);
          }}
          style={{ flex: 1 }}
        >
          <Emblem name={emblemFor('project', project.id)} size={32} />
          <View className="flex-1">
            <Text className="font-heading text-[18px] leading-[24px] text-ink">
              {project.title}
            </Text>
            {hasDescription ? (
              <Text className="mt-1 font-body text-[15px] leading-[20px] text-ink-soft">
                {project.description}
              </Text>
            ) : null}
          </View>
        </PressableFeedback>
        <ActiveButton
          active={active.isActive(project)}
          disabled={disabled}
          label={project.title}
          onToggle={() => {
            active.toggle(project);
          }}
        />
      </View>
      {verdict === null ? null : (
        <View className="px-1 pb-2 pt-1">
          <ActiveVerdict details={active.failureDetails} failure={verdict} />
        </View>
      )}
    </Card>
  );
}
