/**
 * Temporary: favorites mock for story #14. The chosen shared two-line row, "Blooms".
 *
 * It becomes a `ui/core` list row used wherever a flat list is shown: Favorites and Search now. Rows
 * sit straight on the canvas with no card and no dividers. The kind mark stands on its shape, the
 * second line says the kind and names the parent as a small pill, and an archived result carries the
 * Archived pill. It knows nothing about favorites: the star is just one possible trailing control.
 */

import clsx from 'clsx';
import { Archive, Layers } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from 'react-native-reanimated';

import {
  BusyRing,
  colors,
  Emblem,
  FavoriteButton,
  PressableFeedback,
  StatePill,
} from '../../../../ui';
import { projectEmblem, type MockItem, type MockKind } from './mock-data';
import { ShapeMark } from './ShapeMark';

const KIND_WORD: Record<MockKind, string> = { area: 'Area', project: 'Project', note: 'Note' };
/** The star's box, which is also its touch target and the ring's size. */
const STAR_BOX = 44;

export interface MockRowStar {
  readonly favorited: boolean;
  /** A change is in flight: the busy ring turns and the star cannot be pressed. */
  readonly busy: boolean;
  readonly onToggle: () => void;
}

export interface MockRowProps {
  item: MockItem;
  parent: MockItem | null;
  onPress: () => void;
  /** Shows the Archived pill after the kind word. */
  archived?: boolean | undefined;
  star?: MockRowStar | undefined;
  /** A red sentence under the row, for a failed star. */
  failure?: string | null | undefined;
}

/** The star as every toggle in the app does it: the mark stays, a lilac ring turns around it. */
function MockStar({ star, label }: { star: MockRowStar; label: string }) {
  return (
    <View
      className={clsx('items-center justify-center', star.busy && 'opacity-60')}
      pointerEvents={star.busy ? 'none' : 'auto'}
    >
      <FavoriteButton favorited={star.favorited} label={label} onToggle={star.onToggle} size={22} />
      {star.busy ? (
        // Centred on the button whatever its measured width, so the ring circles the mark.
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View style={{ height: STAR_BOX, width: STAR_BOX }}>
            <BusyRing size={STAR_BOX} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The parent, as a small pill with its own mark: "▢ Work". */
function ParentChip({ parent }: { parent: MockItem }) {
  return (
    <View className="flex-row items-center gap-1 rounded-full bg-wave px-2 py-0.5">
      {parent.kind === 'area' ? (
        <Layers color={colors.primary} size={12} strokeWidth={2.2} />
      ) : (
        <Emblem name={projectEmblem(parent)} size={13} />
      )}
      <Text className="font-body-medium text-[13px] text-ink" numberOfLines={1}>
        {parent.title}
      </Text>
    </View>
  );
}

/**
 * One row, faded in as it arrives and faded out as it leaves, while the rows around it slide to
 * close the gap. The same calm settling `Handshake` uses: no bounce, no travel, no stagger, and
 * nothing at all under reduced motion.
 */
export function MockRow({ item, parent, onPress, archived = false, star, failure }: MockRowProps) {
  const reduced = useReducedMotion();
  const motion = reduced
    ? {}
    : {
        entering: FadeIn.duration(220),
        exiting: FadeOut.duration(160),
        layout: LinearTransition.duration(200),
      };
  const spoken = [
    item.title,
    KIND_WORD[item.kind],
    archived ? 'archived' : null,
    parent === null ? null : `in ${parent.title}`,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return (
    <Animated.View {...motion}>
      <View className="flex-row items-center">
        <PressableFeedback
          accessibilityLabel={spoken}
          className="flex-row items-center gap-4 rounded-card py-2.5 pl-1 pr-2"
          onPress={onPress}
          style={{ flex: 1 }}
        >
          <ShapeMark item={item} size={54} />
          <View className="flex-1 gap-1.5">
            <Text className="font-heading text-[16px] leading-[22px] text-ink" numberOfLines={2}>
              {item.title}
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-body text-[14px] text-ink-soft">{KIND_WORD[item.kind]}</Text>
              {archived ? <StatePill icon={Archive} label="Archived" /> : null}
              {parent === null ? null : <ParentChip parent={parent} />}
            </View>
          </View>
        </PressableFeedback>
        {star === undefined ? null : <MockStar label={item.title} star={star} />}
      </View>
      {failure ? (
        <Text
          accessibilityLiveRegion="polite"
          className="pb-2 font-body text-[14px] text-danger"
          style={{ marginLeft: 72 }}
        >
          {failure}
        </Text>
      ) : null}
    </Animated.View>
  );
}

export function MockRowList({ children }: { children: ReactNode }) {
  return <View className="gap-0.5">{children}</View>;
}
