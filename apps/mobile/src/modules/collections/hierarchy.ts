/**
 * The hierarchy, published on its own, for capabilities that only need to read it.
 *
 * A second public entry point beside `index.ts`, and the reason is a dependency cycle rather than
 * taste. `index.ts` publishes the Area and Project screens, and those screens render the resources
 * capability's note sections — so a note screen that reached the hierarchy through `index.ts` would
 * put `collections` and `resources` in a mutual import, where each module's public surface can only
 * finish evaluating after the other's has. That is the kind of edge that works until a refactor
 * reorders it and then fails as an undefined component at startup.
 *
 * So this file exports the read-only hierarchy surface and nothing else: no screens, no creation, no
 * favorites, and nothing from `resources`. It is a leaf as far as the feature modules are concerned,
 * which is what makes it safe for one of them to depend on. `index.ts` re-exports the same names, so
 * there is one definition of what the hierarchy publishes rather than two that could drift.
 *
 * Reading only. Nothing here mutates the hierarchy or invalidates it; a write is the owning
 * capability's business and stays behind `index.ts`.
 */

export { pathSegments, type Hierarchy, type HierarchyNode } from './client/hierarchy';
export {
  ancestorsOf,
  childrenOf,
  containerTitleLookup,
  useContainerPath,
  useHierarchy,
  type ContainerChildren,
  type HierarchyQuery,
} from './client/queries';
