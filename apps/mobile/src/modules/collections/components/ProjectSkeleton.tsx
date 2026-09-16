import { SkeletonBlock, SkeletonGroup } from '../../../ui';

/**
 * The eyebrow, title, and toggle row at their resting heights.
 *
 * It stands in for `ContainerHeader`, so it holds the same three things in the same order. The
 * description is not among them any more: it loads with the body, under "About this project".
 */
export function ProjectHeaderSkeleton() {
  return (
    <SkeletonGroup className="gap-3" label="Loading this project">
      <SkeletonBlock height={18} width={72} />
      <SkeletonBlock height={44} width={220} />
      <SkeletonBlock height={24} width={180} />
    </SkeletonGroup>
  );
}
