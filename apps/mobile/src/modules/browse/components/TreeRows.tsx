import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { Emblem, emblemFor, PressableFeedback } from '../../../ui';
import type { HierarchyNode } from '../../collections';
import { DisclosureButton } from './DisclosureButton';
import {
  TREE_CONNECTOR_X as CONNECTOR_X,
  TREE_HALF_ROW as HALF_ROW,
  TREE_INDENT as INDENT,
  TREE_ROW,
} from './tree-metrics';

/**
 * How one row reads and behaves, decided by whoever is drawing the tree.
 *
 * The renderer owns the grammar - indentation, connectors, disclosure, emblems, wrapping, targets -
 * and nothing else. Whether a row is "current" or "chosen", what it is called to a screen reader,
 * and what sits at its trailing edge are the wrapper's business, because those are the only things
 * that actually differ between browsing a tree and picking a place in one.
 */
export interface TreeRowState {
  /** Highlighted on the wave surface and reported as selected. */
  readonly selected: boolean;
  readonly label: string;
  readonly hint?: string | undefined;
  /** How the row reads to a screen reader. A radio in a picker, an ordinary row when browsing. */
  readonly role?: 'radio' | undefined;
  /** Drawn inside the row's press surface, after the title. A check, or the word "Current". */
  readonly trailing?: ReactNode;
  /** Drawn outside the press surface, so it is its own target and its own control. */
  readonly accessory?: ReactNode;
}

export interface TreeRowsProps {
  nodes: readonly HierarchyNode[];
  expandedIds: ReadonlySet<number>;
  /** True while filtering: every branch is open so matches are visible without tapping. */
  forceExpanded: boolean;
  onToggle: (id: number) => void;
  onSelect: (node: HierarchyNode) => void;
  stateFor: (node: HierarchyNode) => TreeRowState;
  /** A virtual row after the tree, in the rows' own grammar. */
  footer?: ReactNode;
}

/**
 * The area and project tree, drawn once.
 *
 * Browse and the note destination picker have to be the same tree - the same indentation, the same
 * connectors, the same disclosure behaviour and the same targets - because to a person they are the
 * same thing seen twice. The way to guarantee that is for there to be one of them rather than two
 * that agree today, and the way to keep it from becoming a pile of conditional affordances is for
 * the differences to arrive as a row state rather than as flags.
 */
export function TreeRows({
  nodes,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
  stateFor,
  footer,
}: TreeRowsProps) {
  return (
    <View>
      {nodes.map((node) => (
        <TreeBranch
          expandedIds={expandedIds}
          forceExpanded={forceExpanded}
          key={node.id}
          node={node}
          onSelect={onSelect}
          onToggle={onToggle}
          stateFor={stateFor}
        />
      ))}
      {footer}
    </View>
  );
}

interface TreeBranchProps extends Omit<TreeRowsProps, 'nodes' | 'footer'> {
  node: HierarchyNode;
}

function TreeBranch({
  node,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
  stateFor,
}: TreeBranchProps) {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && (forceExpanded || expandedIds.has(node.id));
  const row = stateFor(node);

  return (
    <View>
      <View className="flex-row items-center" style={{ minHeight: TREE_ROW }}>
        {hasChildren ? (
          <DisclosureButton
            expanded={expanded}
            interactive={!forceExpanded}
            name={node.title}
            onPress={() => {
              onToggle(node.id);
            }}
          />
        ) : (
          <View style={{ width: TREE_ROW }} />
        )}
        <PressableFeedback
          accessibilityHint={row.hint}
          accessibilityLabel={row.label}
          accessibilityRole={row.role}
          accessibilityState={{ selected: row.selected }}
          className={clsx(
            'flex-row items-center gap-3 rounded-card px-2 py-1.5',
            row.selected && 'bg-wave',
          )}
          onPress={() => {
            onSelect(node);
          }}
          style={{ flex: 1, justifyContent: 'center', minHeight: TREE_ROW }}
        >
          {/* The navigation boards draw the tree with petals for every project and a bare
              violet layers mark for every area, so the rows read as one list on the sheet
              surface rather than as tiles. */}
          <Emblem background={false} name={emblemFor(node.type, node.id)} size={26} />
          <Text
            className={clsx(
              'flex-1 font-body text-[16px]',
              row.selected ? 'text-primary' : 'text-ink',
            )}
            // Long titles wrap once rather than vanish behind an ellipsis; a third line is cut.
            numberOfLines={2}
          >
            {node.title}
          </Text>
          {row.trailing}
        </PressableFeedback>
        {row.accessory}
      </View>
      {expanded ? (
        <View style={{ paddingLeft: INDENT }}>
          <View
            className="absolute w-px bg-line"
            style={{ bottom: HALF_ROW, left: CONNECTOR_X, top: 0 }}
          />
          {node.children.map((child) => (
            <View key={child.id}>
              <View
                className="absolute h-px bg-line"
                style={{
                  left: CONNECTOR_X - INDENT,
                  top: HALF_ROW,
                  width: INDENT - CONNECTOR_X + 4,
                }}
              />
              <TreeBranch
                expandedIds={expandedIds}
                forceExpanded={forceExpanded}
                node={child}
                onSelect={onSelect}
                onToggle={onToggle}
                stateFor={stateFor}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
