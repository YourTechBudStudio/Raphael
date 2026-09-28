export {
  useProjectActive,
  type ActiveFailure,
  type ActiveTarget,
  type ProjectActive,
} from './client/active';
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
  useContainerArchived,
} from './client/queries';
// The read-only hierarchy is published by `hierarchy.ts` as well, so a capability that needs only
// that much can take it without depending on the screens this file also publishes. Re-exported here
// rather than declared twice: one definition, two doors.
export {
  ancestorsOf,
  childrenOf,
  containerLookup,
  containerTitleLookup,
  pathSegments,
  useContainerPath,
  useHierarchy,
  type ContainerChildren,
  type ContainerPill,
  type Hierarchy,
  type HierarchyNode,
  type HierarchyQuery,
} from './hierarchy';
export {
  useContainerDraft,
  type ContainerDraft,
  type ContainerDraftInput,
  type ContainerSaveOutcome,
  type Fields,
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
export { ProjectScreen } from './components/ProjectScreen';
