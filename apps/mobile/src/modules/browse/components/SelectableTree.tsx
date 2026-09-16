import { Check } from 'lucide-react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { colors } from '../../../ui';
import type { HierarchyNode } from '../../collections';
import { TreeRows, type TreeRowState } from './TreeRows';

export interface SelectableTreeProps {
  nodes: readonly HierarchyNode[];
  /** The chosen place, or null while nothing has been picked. */
  selected: ContainerRef | null;
  expandedIds: ReadonlySet<number>;
  forceExpanded: boolean;
  onToggle: (id: number) => void;
  onSelect: (node: HierarchyNode) => void;
}

/**
 * The same tree, as a list of places to choose between.
 *
 * Rows are radios: tapping one picks it rather than going there, the chosen row is highlighted on
 * the wave surface with a check, and there is no plus and no ghost row - creating a container from
 * here belongs to the strip below the tree, where it can say that the container is made whether or
 * not the note is saved.
 *
 * Published so `capture` can draw it. Browse owns hierarchy presentation; capture owns choosing a
 * destination. Neither owns both.
 */
export function SelectableTree({
  nodes,
  selected,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
}: SelectableTreeProps) {
  const stateFor = (node: HierarchyNode): TreeRowState => {
    const chosen = selected !== null && selected.type === node.type && selected.id === node.id;

    return {
      selected: chosen,
      label: node.title,
      role: 'radio',
      hint: chosen ? `${node.title} is where this note goes` : `Files this note in ${node.title}`,
      trailing: chosen ? <Check color={colors.primary} size={20} strokeWidth={2.4} /> : undefined,
    };
  };

  return (
    <TreeRows
      expandedIds={expandedIds}
      forceExpanded={forceExpanded}
      nodes={nodes}
      onSelect={onSelect}
      onToggle={onToggle}
      stateFor={stateFor}
    />
  );
}
