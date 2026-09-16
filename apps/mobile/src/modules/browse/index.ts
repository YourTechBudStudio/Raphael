/**
 * The browse capability's public interface.
 *
 * Browse owns how the container hierarchy is *drawn*: the indentation, the connectors, the
 * disclosure behaviour, the emblems and the targets. It publishes two things - the screen, and the
 * same tree as a list of places to choose between - so that `capture`'s destination picker is the
 * same tree rather than a second one that agrees today. The renderer underneath both stays private.
 */

export { BrowseScreen, type BrowseScreenProps } from './components/BrowseScreen';
export { SelectableTree, type SelectableTreeProps } from './components/SelectableTree';
/** Pruning a tree to what matches, keeping ancestors visible. The picker filters the same way. */
export { filterTree } from './components/tree';
