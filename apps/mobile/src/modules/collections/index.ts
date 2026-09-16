export { useActiveProjectIds, useProjectActive } from './client/active';
export { useFavorites, useFavoriteToggle } from './client/favorites';
export { allAreas, areaOptions, pathTo, subtreeIds, type AreaOption } from './client/hierarchy';
export { invalidateHierarchy, useContainer } from './client/queries';
// The read-only hierarchy is published by `hierarchy.ts` as well, so a capability that needs only
// that much can take it without depending on the screens this file also publishes. Re-exported here
// rather than declared twice: one definition, two doors.
export {
  ancestorsOf,
  childrenOf,
  containerTitleLookup,
  pathSegments,
  useContainerPath,
  useHierarchy,
  type ContainerChildren,
  type Hierarchy,
  type HierarchyNode,
  type HierarchyQuery,
} from './hierarchy';
export { useCreationStore } from './client/creation';
export { AreaScreen } from './components/AreaScreen';
export { ContainerCreationHost } from './components/ContainerCreationHost';
export { RecoveryScreen } from './components/RecoveryScreen';
export { PendingAttempts, PendingSummary } from './creation';
export { HierarchyError, HierarchyStale } from './components/HierarchyError';
export { CollectionTile } from './components/CollectionTile';
export { ProjectScreen } from './components/ProjectScreen';
