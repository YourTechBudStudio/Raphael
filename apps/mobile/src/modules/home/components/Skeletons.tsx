import { View } from 'react-native';

import { SkeletonBlock, SkeletonGroup } from '../../../ui';

/** Active projects stack at full width, before the recent feed. */
export function ActiveSkeleton() {
  return (
    <SkeletonGroup label="Loading active projects">
      <View className="gap-3">
        <SkeletonBlock height={88} />
        <SkeletonBlock height={88} />
        <SkeletonBlock height={88} />
      </View>
    </SkeletonGroup>
  );
}

/** The feed shape: one full-width voice card over a pair of columns. */
export function NotesSkeleton() {
  return (
    <SkeletonGroup label="Loading notes">
      <View className="gap-4">
        <SkeletonBlock height={172} />
        <View className="flex-row gap-4">
          <SkeletonBlock height={260} />
          <SkeletonBlock height={200} />
        </View>
      </View>
    </SkeletonGroup>
  );
}
