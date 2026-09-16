import clsx from 'clsx';
import { View } from 'react-native';

import type { Resource } from '../../../infrastructure/api/contracts';
import { SectionHeading } from '../../../ui';
import { ResourceGrid, type ResourceGridItem } from './ResourceGrid';

export interface SessionMediaSectionProps {
  items: readonly Resource[];
  className?: string | undefined;
  testID?: string | undefined;
}

/**
 * Media captured in this session, under its own heading.
 *
 * It used to sit under "Notes" beside things that were going to be saved, which made one heading
 * cover two different promises. These recordings have no server operation: they last as long as the
 * process and are gone after that, and "This session" is the shortest true thing to call them.
 *
 * No empty line, no loading shape and no failure line. There is nothing to wait for and nothing that
 * can fail - the data is in this process - so the section simply is not there until something is
 * captured, and a heading with nothing under it would be a promise of a feature rather than a
 * description of what is here.
 */
export function SessionMediaSection({ items, className, testID }: SessionMediaSectionProps) {
  if (items.length === 0) return null;

  // The last voice card takes the full width: its waveform and play control need the room. That is
  // the media arrangement the boards had, and it is kept as it was.
  const last = items[items.length - 1];
  const fullId = last !== undefined && last.kind === 'voice' ? last.id : undefined;
  const gridItems: ResourceGridItem[] = items.map((resource) =>
    resource.id === fullId || items.length === 1 ? { resource, span: 'full' } : { resource },
  );

  return (
    <View className={clsx('gap-3', className)} testID={testID}>
      <SectionHeading>This session</SectionHeading>
      <ResourceGrid items={gridItems} />
    </View>
  );
}
