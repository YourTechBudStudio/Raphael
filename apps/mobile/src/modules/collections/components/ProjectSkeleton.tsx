import { View } from 'react-native';

import { SkeletonBlock, SkeletonGroup } from '../../../ui';

/** The eyebrow, title, and description block at their resting heights. */
export function ProjectHeaderSkeleton() {
  return (
    <SkeletonGroup className="gap-3" label="Loading this project">
      <SkeletonBlock height={18} width={72} />
      <SkeletonBlock height={44} width={220} />
      <SkeletonBlock height={20} width={200} />
    </SkeletonGroup>
  );
}

/** The grid shape: one full-width card over a pair of columns. */
export function ProjectNotesSkeleton() {
  return (
    <SkeletonGroup className="gap-4" label="Loading project notes">
      <SkeletonBlock height={168} />
      <View className="flex-row gap-4">
        <SkeletonBlock height={280} />
        <SkeletonBlock height={200} />
      </View>
    </SkeletonGroup>
  );
}
