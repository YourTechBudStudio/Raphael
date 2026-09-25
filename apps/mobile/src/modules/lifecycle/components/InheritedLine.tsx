import { Archive } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { colors, PressableFeedback } from '../../../ui';
import { inheritedLine, inheritedLineHint, inheritedLineParts } from '../copy.ts';
import type { LifecycleView } from '../view.ts';

export interface InheritedLineProps {
  view: LifecycleView;
  /** Opens a container. Passed in, so lifecycle never depends on the screens' navigation. */
  onOpen: (ref: ContainerRef) => void;
  className?: string | undefined;
}

/**
 * The quiet line under a container's toggles that says why it is archived when the toggle does not.
 *
 * Archived through a container above: "Archived with Area “Work”", or "Also archived with …" beside
 * the user's own archive, and pressing it opens that container, which is where it can be restored.
 * Another owner's cause is plain text, because there is nowhere to go. Nothing at all when the only
 * cause is the user's own: the filled Archive toggle already says it.
 */
export function InheritedLine({ view, onOpen, className }: InheritedLineProps) {
  const parts = inheritedLineParts(view);
  const sentence = inheritedLine(view);

  if (parts === null || sentence === null) return null;

  const origin = parts.origin === null ? undefined : view.nearestInherited?.origin;
  const icon = <Archive color={colors.inkSoft} size={16} strokeWidth={2} />;

  if (origin === undefined || (origin.type !== 'area' && origin.type !== 'project')) {
    return (
      <View
        accessibilityLabel={sentence}
        accessible
        className={['mt-2 min-h-11 flex-row items-center gap-2', className ?? ''].join(' ')}
        testID="inherited-line"
      >
        {icon}
        <Text className="flex-1 font-body text-[15px] leading-[22px] text-ink-soft">
          {sentence}
        </Text>
      </View>
    );
  }

  const ref: ContainerRef = { type: origin.type, id: origin.id };

  return (
    <PressableFeedback
      accessibilityHint={inheritedLineHint(origin.title)}
      accessibilityLabel={sentence}
      accessibilityRole="button"
      className={[
        'mt-2 min-h-11 flex-row items-center gap-2 self-start pr-2',
        className ?? '',
      ].join(' ')}
      onPress={() => {
        onOpen(ref);
      }}
      testID="inherited-line"
      treatment="button"
    >
      {icon}
      <Text className="shrink font-body text-[15px] leading-[22px] text-ink-soft">
        {parts.lead}
        <Text className="font-body-medium text-primary">{parts.origin}</Text>
      </Text>
    </PressableFeedback>
  );
}
