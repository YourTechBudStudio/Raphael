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
