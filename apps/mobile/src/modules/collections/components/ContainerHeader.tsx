import type { ReactNode } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';

import type { ContainerType } from '../../../infrastructure/api/contracts';
import { Eyebrow, gutter } from '../../../ui';
import { containerTitleType, TITLE_MAX_LINES } from './container-title';

/** The eyebrow is the kind said as a word. Derived here so a screen cannot name a kind twice. */
const KIND_WORD: Record<ContainerType, string> = { area: 'Area', project: 'Project' };

export interface ContainerHeaderProps {
  /** Which kind of container this is. The word above the title is derived from it. */
  kind: ContainerType;
  title: string;
  /** The state toggles for this container, in one row under the title. */
  toggles?: ReactNode | undefined;
  testID?: string | undefined;
}

/**
 * What a container is, said once: its kind, its name, and what is true of it.
 *
 * It holds identity and nothing else. The description is not here - it went down to "About this
 * area" with the body, because these screens are mostly passed through on the way to something
 * inside them, and a router reads the title and the tiles, not the summary. Nothing that *creates*
 * is here either; that is one plus in the top bar.
 *
 * One component for both screens because they had already drifted - the same star at 22px on one
 * and 24px on the other - and the two headers are the same object with a different number of
 * toggles, not two designs that happen to look alike.
 */
export function ContainerHeader({ kind, title, toggles, testID }: ContainerHeaderProps) {
  const { width, fontScale } = useWindowDimensions();
  // What the title actually gets: the screen less the gutters it sits between, at the text size
  // this person reads at. The toggles are on their own row, so nothing shares the line with it.
  const type = containerTitleType(title, width - gutter * 2, fontScale);

  return (
    <View testID={testID}>
      <Eyebrow>{KIND_WORD[kind]}</Eyebrow>
      <Text
        // The cut, rather than the estimate, is what holds the header to two lines: a title long
        // enough fits neither at the floor, and a nine-line heading is the thing this block exists
        // to avoid. The label carries the whole title regardless, so nothing announced is lost -
        // only what a header has room to show.
        accessibilityLabel={title}
        accessibilityRole="header"
        className="mt-1 font-heading text-ink"
        numberOfLines={TITLE_MAX_LINES}
        style={type}
      >
        {title}
      </Text>
      {toggles === undefined ? null : (
        <View className="mt-4 flex-row flex-wrap items-center gap-x-5 gap-y-1">{toggles}</View>
      )}
    </View>
  );
}
