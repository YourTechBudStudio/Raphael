import clsx from 'clsx';
import { Check } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { colors, Emblem, PressableFeedback } from '../../../ui';
import type { HierarchyNode } from '../../collections';
import { TREE_ROW } from './tree-metrics';
import { TreeRows, type TreeRowState } from './TreeRows';

export interface SelectableTreeProps {
  nodes: readonly HierarchyNode[];
  /** The chosen place, or null while nothing has been picked. */
  selected: ContainerRef | null;
  expandedIds: ReadonlySet<number>;
  forceExpanded: boolean;
  onToggle: (id: number) => void;
  onSelect: (node: HierarchyNode) => void;
  /** Row sentences. Defaults to the note-filing copy this tree was first drawn for. */
  rowCopy?: SelectableRowCopy | undefined;
  /** The top level as a place of its own, drawn above the tree. Only where the root can be chosen. */
  root?: SelectableRoot | undefined;
}

/** The root, offered as a row. It is no node of the hierarchy, so the chooser describes it whole. */
export interface SelectableRoot {
  readonly label: string;
  /** A quiet word beside the label that says what the row stands for. */
  readonly tag: string;
  readonly hint: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly testID?: string | undefined;
}

/** What a row says to a screen reader: before it is chosen, and once it is. */
export interface SelectableRowCopy {
  readonly hint: (title: string) => string;
  readonly chosen: (title: string) => string;
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
  rowCopy,
  root,
}: SelectableTreeProps) {
  const stateFor = (node: HierarchyNode): TreeRowState => {
    const chosen = selected !== null && selected.type === node.type && selected.id === node.id;

    return {
      selected: chosen,
      label: node.title,
      role: 'radio',
      hint: chosen
        ? (rowCopy?.chosen(node.title) ?? `${node.title} is where this note goes`)
        : (rowCopy?.hint(node.title) ?? `Files this note in ${node.title}`),
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
      header={root === undefined ? undefined : <RootRow root={root} />}
      stateFor={stateFor}
    />
  );
}

/**
 * The root in the tree's own row grammar: an empty disclosure slot, the layers mark where an emblem
 * sits, and the wave surface and check once chosen.
 */
function RootRow({ root }: { root: SelectableRoot }) {
  return (
    <View className="flex-row items-center" style={{ minHeight: TREE_ROW }}>
      <View style={{ width: TREE_ROW }} />
      <PressableFeedback
        accessibilityHint={root.hint}
        accessibilityLabel={`${root.label}, ${root.tag}`}
        accessibilityRole="radio"
        accessibilityState={{ selected: root.selected }}
        className={clsx(
          'flex-row items-center gap-3 rounded-card px-2 py-1.5',
          root.selected && 'bg-wave',
        )}
        onPress={root.onSelect}
        style={{ flex: 1, justifyContent: 'center', minHeight: TREE_ROW }}
        testID={root.testID}
      >
        <Emblem background={false} name="layers" size={26} />
        <View className="flex-1 flex-row flex-wrap items-baseline gap-x-2">
          <Text
            className={clsx('font-body text-[16px]', root.selected ? 'text-primary' : 'text-ink')}
          >
            {root.label}
          </Text>
          <Text className="font-body text-[13px] text-ink-soft">{root.tag}</Text>
        </View>
        {root.selected ? <Check color={colors.primary} size={20} strokeWidth={2.4} /> : null}
      </PressableFeedback>
    </View>
  );
}
