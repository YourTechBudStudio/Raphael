import type { NodeType, ResourceKind } from '@raphael/contracts/nodes';
import { X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { colors, IconButton, SearchField, Sheet, SheetBody, SheetHeader } from '../../../ui';
import { filterTree, SelectableTree } from '../../browse';
import {
  ancestorsOf,
  HierarchyError,
  HierarchyStale,
  useHierarchy,
  type HierarchyNode,
} from '../../collections';
import {
  editKindWord,
  MOVE_CLOSE_WAITING_HINT,
  MOVE_ROOT_CURRENT_HINT,
  MOVE_ROOT_HINT,
  MOVE_ROOT_LABEL,
  MOVE_ROOT_PLACE,
  MOVE_ROOT_TAG,
  MOVE_SHEET_TITLE,
  MOVE_TREE_EMPTY,
  MOVE_TREE_FAILED,
  MOVE_TREE_NO_MATCH,
  moveBusySubtitle,
  moveRowCopy,
  moveSheetSubtitle,
} from '../copy.ts';
import { eligibleDestinations, offersRoot } from '../move-eligibility.ts';

export interface MoveSheetProps {
  visible: boolean;
  /** Bumped per opening; the selection, the filter and any sentence are seeded from that moment. */
  sessionId: number;
  /** What is moving. It keeps its slug. */
  entity: {
    readonly id: number;
    readonly type: NodeType;
    readonly kind: ResourceKind | null;
  };
  /** Where it is now. Null is the top level. */
  parentId: number | null;
  /** Where it is now, named the way the eyebrow names it. */
  currentName: string;
  /** Issues the move. The composition closes the sheet when it answers, whichever way. */
  onMove: (destination: { readonly parentId: number | null }) => Promise<void>;
  onClose: () => void;
}

/** A move that is out, and what the place it is going to is called. */
interface Pending {
  readonly parentId: number | null;
  readonly place: string;
}

/**
 * Where should this go?
 *
 * The destination sheet's tree, pruned to the places that can hold this, and tapping a place is the
 * move: there is no confirm, and a mis-tap is repaired by moving it back. While the answer is out,
 * nothing closes the sheet. The composition closes it when the answer comes, and says in a snackbar
 * if the move did not go through.
 */
export function MoveSheet({
  visible,
  sessionId,
  entity,
  parentId,
  currentName,
  onMove,
  onClose,
}: MoveSheetProps) {
  const tree = useHierarchy();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(parentId);
  const [pending, setPending] = useState<Pending | null>(null);
  /** The opening an answer belongs to. An answer for an earlier opening says nothing about this one. */
  const opening = useRef(sessionId);

  const hierarchy = tree.hierarchy;
  const filtering = query.trim() !== '';
  const { id: entityId, type: entityType } = entity;
  const nodes = useMemo(
    // Pruned first, so a filter matches only places that are offered.
    () =>
      filterTree(
        eligibleDestinations(hierarchy?.roots ?? [], { id: entityId, type: entityType }),
        query,
      ),
    [hierarchy, entityId, entityType, query],
  );
  const root = offersRoot(entity.type);

  // Where this is now, and everything above it, opens - so the check is on screen when the sheet is.
  const ancestorIds = useMemo(
    () => ancestorsOf(hierarchy, parentId).map((step) => step.id),
    [hierarchy, parentId],
  );

  useEffect(() => {
    opening.current = sessionId;
    setQuery('');
    setSelected(parentId);
    setPending(null);
    setExpanded(new Set());
    // Seeded per opening only: a location that changes while the sheet is open is an answer, and
    // what an answer does to the selection is decided where it is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [sessionId]);

  useEffect(() => {
    if (!visible || ancestorIds.length === 0) return;

    setExpanded((current) => new Set([...current, ...ancestorIds]));
  }, [visible, ancestorIds]);

  const busy = pending !== null;
  const word = editKindWord(entity.type, entity.kind).toLowerCase();
  const rowCopy = useMemo(() => moveRowCopy(word), [word]);

  const moveTo = (target: number | null, place: string) => {
    if (busy) return;
    if (target === parentId) {
      onClose();

      return;
    }

    const asked = opening.current;

    setSelected(target);
    setPending({ parentId: target, place });

    void onMove({ parentId: target }).then(() => {
      if (opening.current !== asked) return;

      setPending(null);
      setSelected(parentId);
    });
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const selectedRef = (): ContainerRef | null => {
    if (selected === null) return null;

    const node = hierarchy?.byId.get(selected);

    return node === undefined ? null : { type: node.type, id: node.id };
  };

  const subtitle = busy ? moveBusySubtitle(pending.place) : moveSheetSubtitle(currentName);

  const treeRows = (
    <SelectableTree
      expandedIds={expanded}
      forceExpanded={filtering}
      nodes={nodes}
      onSelect={(node: HierarchyNode) => {
        moveTo(node.id, node.title);
      }}
      onToggle={(id) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);

          return next;
        });
      }}
      root={
        root
          ? {
              label: MOVE_ROOT_LABEL,
              tag: MOVE_ROOT_TAG,
              hint: parentId === null ? MOVE_ROOT_CURRENT_HINT : MOVE_ROOT_HINT,
              selected: selected === null,
              onSelect: () => {
                moveTo(null, MOVE_ROOT_PLACE);
              },
              testID: 'move-root',
            }
          : undefined
      }
      rowCopy={rowCopy}
      selected={selectedRef()}
    />
  );

  return (
    <Sheet
      className="gap-4 px-5 pb-4 pt-3"
      closeUnavailable={busy ? MOVE_CLOSE_WAITING_HINT : undefined}
      label="the move sheet"
      onClose={close}
      snapHeight={560}
      testID="move-sheet"
      visible={visible}
    >
      <SheetHeader
        leading={
          <IconButton
            accessibilityHint={busy ? MOVE_CLOSE_WAITING_HINT : undefined}
            disabled={busy}
            icon={X}
            label="Close"
            onPress={close}
            testID="move-close"
          />
        }
        subtitle={subtitle}
        title={MOVE_SHEET_TITLE}
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
        {/* A tree kept from an earlier reading whose refresh failed: still drawn, since it was
            complete and true, but said to be possibly out of date, with the same retry rule. */}
        <HierarchyStale className="mb-3" tree={tree} />
        {hierarchy === undefined ? (
          // The top level needs no reading of the tree, so an area keeps it while the tree loads
          // or fails. The sheet stays mounted while closed, so reopening it does not ask again:
          // the retry is offered here, by the same rule every hierarchy failure follows.
          <View className="gap-4">
            {root ? treeRows : null}
            {tree.isError ? (
              <HierarchyError title={MOVE_TREE_FAILED} tree={tree} />
            ) : (
              <View className="items-center py-8">
                <ActivityIndicator
                  accessibilityLabel="Loading areas and projects"
                  color={colors.primary}
                />
              </View>
            )}
          </View>
        ) : nodes.length === 0 && !root ? (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            {filtering ? MOVE_TREE_NO_MATCH : MOVE_TREE_EMPTY}
          </Text>
        ) : (
          <>
            {treeRows}
            {/* The top level is always offered to an area, so only a filter can leave it alone. */}
            {nodes.length === 0 && filtering ? (
              <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
                {MOVE_TREE_NO_MATCH}
              </Text>
            ) : null}
          </>
        )}
      </SheetBody>
    </Sheet>
  );
}
