/**
 * THROWAWAY MOCK. The Browse tree, redrawn for picking: same indent, connectors, disclosure
 * chevrons and emblems, but a row is a radio and the chosen one shows a check.
 */

import clsx from 'clsx';
import { Check } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { colors, Emblem, emblemFor, PressableFeedback } from '../../../ui';
import { DisclosureButton } from '../../browse';
import type { MockDestination, MockNode } from '../data';

const INDENT = 28;
const CONNECTOR_X = 22;
const HALF_ROW = 22;
const ROW = 44;

export interface MockTreeProps {
  nodes: readonly MockNode[];
  selected: MockDestination | null;
  expandedIds: ReadonlySet<number>;
  forceExpanded: boolean;
  onToggle: (id: number) => void;
  onSelect: (destination: MockDestination) => void;
}

export function MockTree({
  nodes,
  selected,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
}: MockTreeProps) {
  return (
    <View>
      {nodes.map((node) => (
        <Branch
          expandedIds={expandedIds}
          forceExpanded={forceExpanded}
          key={node.id}
          node={node}
          onSelect={onSelect}
          onToggle={onToggle}
          path={[]}
          selected={selected}
        />
      ))}
    </View>
  );
}

interface BranchProps extends Omit<MockTreeProps, 'nodes'> {
  node: MockNode;
  path: readonly string[];
}

function Branch({
  node,
  path,
  selected,
  expandedIds,
  forceExpanded,
  onToggle,
  onSelect,
}: BranchProps) {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && (forceExpanded || expandedIds.has(node.id));
  const on = selected !== null && selected.type === node.type && selected.id === node.id;

  return (
    <View>
      <View className="flex-row items-center" style={{ minHeight: ROW }}>
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
          <View style={{ width: ROW }} />
        )}
        <PressableFeedback
          accessibilityHint={`Files this note in ${node.title}`}
          accessibilityLabel={`${node.type === 'area' ? 'Area' : 'Project'} ${node.title}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: on }}
          className={clsx('flex-row items-center gap-3 rounded-card px-2 py-1.5', on && 'bg-wave')}
          onPress={() => {
            onSelect({ type: node.type, id: node.id, title: node.title, path });
          }}
          style={{ flex: 1, justifyContent: 'center', minHeight: ROW }}
        >
          <Emblem background={false} name={emblemFor(node.type, node.id)} size={26} />
          <Text
            className={clsx('flex-1 font-body text-[16px]', on ? 'text-primary' : 'text-ink')}
            numberOfLines={2}
          >
            {node.title}
          </Text>
          {on ? <Check color={colors.primary} size={20} strokeWidth={2.4} /> : null}
        </PressableFeedback>
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
              <Branch
                expandedIds={expandedIds}
                forceExpanded={forceExpanded}
                node={child}
                onSelect={onSelect}
                onToggle={onToggle}
                path={[...path, node.title]}
                selected={selected}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
