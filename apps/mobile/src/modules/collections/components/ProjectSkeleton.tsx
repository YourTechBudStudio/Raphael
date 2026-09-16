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
