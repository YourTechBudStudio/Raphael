import { Plus } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { colors, IconButton, PressableFeedback } from '../../../ui';
import type { HierarchyNode } from '../../collections';
import { TREE_ROW } from './tree-metrics';
import { TreeRows, type TreeRowState } from './TreeRows';

export interface BrowseTreeProps {
  nodes: readonly HierarchyNode[];
  /** The node Browse was opened from, highlighted as current. Null when opened from Home. */
  current: ContainerRef | null;
  expandedIds: ReadonlySet<number>;
  /** True while filtering: every branch is open so matches are visible without tapping. */
  forceExpanded: boolean;
  onToggle: (id: number) => void;
  onSelect: (node: HierarchyNode) => void;
  /** Offered on area rows only: a plus at the trailing edge to create inside that area. */
  onAdd?: ((node: HierarchyNode) => void) | undefined;
  /** Draws a virtual last root row that creates a top-level area. */
  onAddRoot?: (() => void) | undefined;
}

/**
 * The tree on the Browse screen: one you walk, with somewhere to add things.
 *
 * A wrapper over the shared renderer rather than a tree of its own. What Browse adds is the current
 * highlight, the per-area plus and the ghost row; the grammar underneath is the same one the note
 * destination picker draws, and keeping it one implementation is what stops the two drifting.
 */
export function BrowseTree({
  nodes,
  current,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
  onAdd,
  onAddRoot,
}: BrowseTreeProps) {
  const stateFor = (node: HierarchyNode): TreeRowState => {
    const isCurrent = current !== null && current.type === node.type && current.id === node.id;

    return {
      selected: isCurrent,
      label: isCurrent ? `${node.title}, current` : node.title,
      hint: isCurrent ? 'Closes Browse' : `Opens ${node.title}`,
      trailing: isCurrent ? (
        <Text className="font-body-medium text-[14px] text-primary">Current</Text>
      ) : undefined,
      // Only areas hold things, so only area rows get the plus. It sits outside the row's press
      // surface so it is its own 44pt target for touch and its own control for a screen reader.
      accessory:
        node.type === 'area' && onAdd !== undefined ? (
          <IconButton
            accessibilityHint={`Creates an area or a project inside ${node.title}`}
            color={colors.primary}
            icon={Plus}
            iconSize={20}
            label={`Add inside ${node.title}`}
            onPress={() => {
              onAdd(node);
            }}
          />
        ) : undefined,
    };
  };

  return (
    <TreeRows
      expandedIds={expandedIds}
      footer={onAddRoot === undefined ? undefined : <NewAreaRow onPress={onAddRoot} />}
      forceExpanded={forceExpanded}
      nodes={nodes}
      onSelect={onSelect}
      onToggle={onToggle}
      stateFor={stateFor}
    />
  );
}

/**
 * The root's last row is not a container but the place one would go, drawn in the rows' own
 * grammar: the disclosure slot left empty, a dotted outline with a plus where the emblem sits,
 * and the title in soft ink. Nothing bordered, nothing pill-shaped - it is a row that is not
 * there yet, not a button dropped into a list.
 */
function NewAreaRow({ onPress }: { onPress: () => void }) {
  return (
    <View className="flex-row items-center" style={{ minHeight: TREE_ROW }}>
      <View style={{ width: TREE_ROW }} />
      <PressableFeedback
        accessibilityHint="Creates an area at the top level"
        accessibilityLabel="New area"
        className="flex-row items-center gap-3 rounded-card px-2 py-1.5"
        onPress={onPress}
        style={{ flex: 1, justifyContent: 'center', minHeight: TREE_ROW }}
      >
        <View
          className="items-center justify-center rounded-full border border-lilac"
          style={{ borderStyle: 'dotted', height: 26, width: 26 }}
        >
          <Plus color={colors.primary} size={15} strokeWidth={2.2} />
        </View>
        <Text className="flex-1 font-body text-[16px] text-ink-soft">New area</Text>
      </PressableFeedback>
    </View>
  );
}
