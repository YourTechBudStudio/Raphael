export {
  useProjectActive,
  type ActiveFailure,
  type ActiveTarget,
  type ProjectActive,
} from './client/active';
export { useFavorites, useFavoriteToggle } from './client/favorites';
export {
  activeProjects,
  allAreas,
  areaOptions,
  pathTo,
  subtreeIds,
  type AreaOption,
} from './client/hierarchy';
export {
  invalidateContainer,
  invalidateHierarchy,
  invalidatePaths,
  useContainer,
} from './client/queries';
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
export {
  useContainerCreationSession,
  type ContainerCreationInput,
  type ContainerCreationOutcome,
  type ContainerCreationSession,
} from './client/container-creation';
export { ActiveVerdict } from './components/ActiveVerdict';
export { AreaScreen } from './components/AreaScreen';
export {
  AddInsideSheet,
  type AddInsideSheetProps,
  type AddInsideTarget,
} from './components/AddInsideSheet';
export { ContainerCreationHost } from './components/ContainerCreationHost';
export { NewContainerSheet, type NewContainerSheetProps } from './components/NewContainerSheet';
export { HierarchyError, HierarchyStale } from './components/HierarchyError';
export { CollectionTile } from './components/CollectionTile';
export { ProjectScreen } from './components/ProjectScreen';
