import type { LucideIcon } from 'lucide-react-native';
import { Layers } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from 'react-native-reanimated';

import { colors } from '../theme';
import { Emblem } from './Emblem';
import { emblemFor } from './emblem-for';
import { PressableFeedback } from './PressableFeedback';
import { ShapeMark, type MarkKind } from './ShapeMark';
import { StatePill } from './StatePill';

/** Rows arrive, leave and close gaps the way `Handshake` settles: calm, linear, no travel. */
const ENTER_MS = 220;
const EXIT_MS = 160;
const SHIFT_MS = 200;

/** The mark's box beside the title. */
const MARK_SIZE = 54;

/** How far the failure line sits in, so it starts under the title rather than under the mark. */
const FAILURE_INDENT = 72;

/** The container a row lives in, as the pill on its second line names it. */
export interface ListRowParent {
  readonly kind: 'area' | 'project';
  readonly id: number;
  readonly title: string;
}

/** A state the row is in, drawn as a pill and said in the row's spoken label. */
export interface ListRowStatus {
  readonly icon: LucideIcon;
  /** The state in one word, such as "Archived". Passed in: `ui` holds no product wording. */
  readonly label: string;
}

export interface ListRowProps {
  mark: { kind: MarkKind; id: number };
  /** Sora 16, at most two lines. */
  title: string;
  /** The kind in a word - "Area", "Project", "Note" - from the caller. */
  kindLabel: string;
  /** Drawn after the kind word, and spoken after it too. */
  status?: ListRowStatus | undefined;
  /** Drawn last on the second line. Leave it out when the container cannot be named truthfully. */
  parent?: ListRowParent | undefined;
  /** A control beside the row, outside its press surface, so it is its own touch target. */
  trailing?: ReactNode;
  /** A danger sentence under the row, for an action on it that did not go through. */
  failure?: string | null | undefined;
  onPress: () => void;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
}

/** The parent, as a small pill with its own tiny mark: "▢ Work". */
function ParentPill({ parent }: { parent: ListRowParent }) {
  return (
    <View className="flex-row items-center gap-1 rounded-full bg-wave px-2 py-0.5">
      {parent.kind === 'area' ? (
        <Layers color={colors.primary} size={12} strokeWidth={2.2} />
      ) : (
        <Emblem name={emblemFor('project', parent.id)} size={13} />
      )}
      <Text className="font-body-medium text-[13px] text-ink" numberOfLines={1}>
        {parent.title}
      </Text>
    </View>
  );
}

/**
 * One row of a flat list - Search, Favorites, and any flat list after them.
 *
 * Rows sit straight on the canvas with no card and no dividers. The mark stands on its shape, the
 * title takes the first line, and the second says the kind, then any state, then the container it
 * lives in. It knows nothing about what the list is for: a star, or any other control, is just
 * something the caller puts in the trailing slot.
 *
 * The press surface speaks for everything drawn inside it - "<title>, <kind>, archived, in <parent>"
 * - because the pill and the mark are silent on purpose, and a screen reader should hear one row,
 * not four fragments of one.
 *
 * Each row fades in as it arrives and out as it leaves, while the rows around it slide to close the
 * gap. No spring, stagger or travel, and nothing at all under reduced motion.
 */
export function ListRow({
  mark,
  title,
  kindLabel,
  status,
  parent,
  trailing,
  failure,
  onPress,
  accessibilityHint,
  testID,
}: ListRowProps) {
  const reducedMotion = useReducedMotion();
  const motion = reducedMotion
    ? {}
    : {
        entering: FadeIn.duration(ENTER_MS),
        exiting: FadeOut.duration(EXIT_MS),
        layout: LinearTransition.duration(SHIFT_MS),
      };
  const spoken = [
    title,
    kindLabel,
    status === undefined ? null : status.label.toLowerCase(),
    parent === undefined ? null : `in ${parent.title}`,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return (
    <Animated.View {...motion} testID={testID}>
      <View className="flex-row items-center">
        <PressableFeedback
          accessibilityHint={accessibilityHint}
          accessibilityLabel={spoken}
          className="flex-row items-center gap-4 rounded-card py-2.5 pl-1 pr-2"
          onPress={onPress}
          style={{ flex: 1 }}
        >
          <ShapeMark id={mark.id} kind={mark.kind} size={MARK_SIZE} />
          <View className="flex-1 gap-1.5">
            <Text className="font-heading text-[16px] leading-[22px] text-ink" numberOfLines={2}>
              {title}
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-body text-[14px] text-ink-soft">{kindLabel}</Text>
              {status === undefined ? null : <StatePill icon={status.icon} label={status.label} />}
              {parent === undefined ? null : <ParentPill parent={parent} />}
            </View>
          </View>
        </PressableFeedback>
        {trailing}
      </View>
      {failure ? (
        <Text
          accessibilityLiveRegion="polite"
          className="pb-2 font-body text-[14px] text-danger"
          style={{ marginLeft: FAILURE_INDENT }}
        >
          {failure}
        </Text>
      ) : null}
    </Animated.View>
  );
}
