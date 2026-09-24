/**
 * Temporary: move mock for story #7. The move sheet, drawn from the destination sheet's parts.
 *
 * Tapping a place is the move; tapping where it already is closes the sheet, the way tapping the
 * current row closes Browse. Further taps are ignored while the (pretend) answer is out.
 */

import { X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { IconButton, SearchField, Sheet, SheetBody, SheetHeader } from '../../../../ui';
import { filterTree, SelectableTree } from '../../../browse';
import type { HierarchyNode } from '../../../collections';
import { MOCK_ROOTS, mockAncestors, mockNode } from './move-mock-data';

export interface MockMoveSheetProps {
  visible: boolean;
  sessionId: number;
  parentId: number;
  onMoved: (parentId: number) => void;
  onClose: () => void;
}

export function MockMoveSheet({
  visible,
  sessionId,
  parentId,
  onMoved,
  onClose,
}: MockMoveSheetProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [selected, setSelected] = useState(parentId);
  const [busy, setBusy] = useState(false);

  const filtering = query.trim() !== '';
  const nodes = useMemo(() => filterTree(MOCK_ROOTS, query), [query]);

  // Each opening starts where the note is now, with its ancestors open so the check is on screen.
  useEffect(() => {
    setQuery('');
    setSelected(parentId);
    setBusy(false);
    setExpanded(new Set(mockAncestors(parentId).map((step) => step.id)));
  }, [sessionId, parentId]);

  const titleOf = (id: number): string => mockNode(id)?.title ?? '';
  const subtitle = busy
    ? `Moving to ${titleOf(selected)}…`
    : `In ${titleOf(parentId)} now. Tap a place to move this there.`;

  const moveTo = (picked: HierarchyNode) => {
    if (busy) return;
    if (picked.id === parentId) {
      onClose();

      return;
    }

    setSelected(picked.id);
    setBusy(true);
    setTimeout(() => {
      onMoved(picked.id);
    }, 600);
  };

  const selectedNode = mockNode(selected);

  return (
    <Sheet
      className="gap-4 px-5 pb-4 pt-3"
      label="the move sheet"
      onClose={onClose}
      snapHeight={560}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={onClose} />}
        subtitle={subtitle}
        title="Where should this go?"
        trailing={<View className="w-11" />}
      />

      <SearchField
        accessibilityLabel="Filter areas and projects"
        onChangeText={setQuery}
        onClear={() => {
          setQuery('');
        }}
        placeholder="Find an area or project"
        value={query}
      />

      <SheetBody className="flex-1">
        <SelectableTree
          expandedIds={expanded}
          forceExpanded={filtering}
          nodes={nodes}
          onSelect={moveTo}
          onToggle={(id) => {
            setExpanded((current) => {
              const next = new Set(current);
              if (!next.delete(id)) next.add(id);

              return next;
            });
          }}
          selected={
            selectedNode === undefined ? null : { type: selectedNode.type, id: selectedNode.id }
          }
        />
      </SheetBody>
    </Sheet>
  );
}
