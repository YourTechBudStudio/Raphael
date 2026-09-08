import clsx from 'clsx';
import { Text, View } from 'react-native';

import type { BrowseNode, ParentRef } from '../../../infrastructure/api/contracts';
import { Emblem, PressableFeedback } from '../../../ui';
import { DisclosureButton } from './DisclosureButton';

/** Each level steps in by this much, per the navigation boards. */
const INDENT = 28;
/** Where the connector line sits inside a level: under the centre of the parent's chevron. */
const CONNECTOR_X = 22;
/** Half a row, so the line stops at the last child instead of running past it. */
const HALF_ROW = 22;
/** Row height and disclosure slot: also the minimum tap target for a row. */
const ROW = 44;

export interface BrowseTreeProps {
  nodes: readonly BrowseNode[];
  /** The node the sheet was opened from, highlighted as current. Null when opened from Home. */
  current: ParentRef | null;
  expandedIds: ReadonlySet<string>;
  /** True while filtering: every branch is open so matches are visible without tapping. */
  forceExpanded: boolean;
  onToggle: (id: string) => void;
  onSelect: (node: BrowseNode) => void;
}

/** The area and project tree inside the Browse sheet. */
export function BrowseTree({
  nodes,
  current,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
}: BrowseTreeProps) {
  return (
    <View>
      {nodes.map((node) => (
        <BrowseBranch
          current={current}
          expandedIds={expandedIds}
          forceExpanded={forceExpanded}
          key={`${node.type}:${node.id}`}
          node={node}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

interface BrowseBranchProps extends Omit<BrowseTreeProps, 'nodes'> {
  node: BrowseNode;
}

function BrowseBranch({
  node,
  current,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
}: BrowseBranchProps) {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && (forceExpanded || expandedIds.has(node.id));
  const isCurrent = current !== null && current.type === node.type && current.id === node.id;

  return (
    <View>
      <View className="flex-row items-center" style={{ minHeight: ROW }}>
        {hasChildren ? (
          <DisclosureButton
            expanded={expanded}
            interactive={!forceExpanded}
            name={node.name}
            onPress={() => {
              onToggle(node.id);
            }}
          />
        ) : (
          <View style={{ width: ROW }} />
        )}
        <PressableFeedback
          accessibilityHint={isCurrent ? 'Closes Browse' : `Opens ${node.name}`}
          accessibilityLabel={isCurrent ? `${node.name}, current` : node.name}
          accessibilityState={{ selected: isCurrent }}
          className={clsx(
            'flex-row items-center gap-3 rounded-card px-2 py-1.5',
            isCurrent && 'bg-wave',
          )}
          onPress={() => {
            onSelect(node);
          }}
          style={{ flex: 1, justifyContent: 'center', minHeight: ROW }}
        >
          {/* The navigation boards draw the tree with petals for every project and a bare
              violet layers mark for every area, so the rows read as one list on the sheet
              surface rather than as tiles. */}
          <Emblem
            background={false}
            name={node.type === 'project' ? 'petals' : node.emblem}
            size={26}
          />
          <Text
            className={clsx(
              'flex-1 font-body text-[16px]',
              isCurrent ? 'text-primary' : 'text-ink',
            )}
            numberOfLines={1}
          >
            {node.name}
          </Text>
          {isCurrent ? (
            <Text className="font-body-medium text-[14px] text-primary">Current</Text>
          ) : null}
        </PressableFeedback>
      </View>
      {expanded ? (
        <View style={{ paddingLeft: INDENT }}>
          <View
            className="absolute w-px bg-line"
            style={{ bottom: HALF_ROW, left: CONNECTOR_X, top: 0 }}
          />
          {node.children.map((child) => (
            <View key={`${child.type}:${child.id}`}>
              <View
                className="absolute h-px bg-line"
                style={{
                  left: CONNECTOR_X - INDENT,
                  top: HALF_ROW,
                  width: INDENT - CONNECTOR_X + 4,
                }}
              />
              <BrowseBranch
                current={current}
                expandedIds={expandedIds}
                forceExpanded={forceExpanded}
                node={child}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
