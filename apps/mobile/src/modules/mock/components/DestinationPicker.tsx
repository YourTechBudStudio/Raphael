/**
 * THROWAWAY MOCK. Choosing where a note goes: the Browse hierarchy, drawn as a picker. Selection
 * is preserved until another row is tapped, and a destination can be created without leaving.
 */

import { Plus, Search, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import {
  Chip,
  colors,
  IconButton,
  SavePill,
  SearchField,
  Sheet,
  SheetBody,
  SheetHeader,
} from '../../../ui';
import { MOCK_TREE, withCreated, type MockDestination } from '../data';
import { pruneTree } from '../prune';
import { useMockStore } from '../state';
import { MockTree } from './MockTree';

export interface DestinationPickerProps {
  visible: boolean;
  selected: MockDestination | null;
  onSelect: (destination: MockDestination) => void;
  onClose: () => void;
}

export function DestinationPicker({
  visible,
  selected,
  onSelect,
  onClose,
}: DestinationPickerProps) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set([1]));
  const [creating, setCreating] = useState<'area' | 'project' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const created = useMockStore((state) => state.created);
  const addCreated = useMockStore((state) => state.addCreated);

  const tree = useMemo(() => withCreated(MOCK_TREE, created), [created]);
  const needle = filter.trim().toLowerCase();
  const visibleTree = useMemo(() => pruneTree(tree, needle), [tree, needle]);

  const close = () => {
    setCreating(null);
    setNewTitle('');
    onClose();
  };

  const toggle = (id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  };

  const create = () => {
    if (creating === null || newTitle.trim() === '') return;

    // A created container is committed on its own; the note only takes a reference to it.
    const parent = selected?.type === 'area' ? selected : null;
    const node = {
      type: creating,
      id: 900 + created.length,
      title: newTitle.trim(),
      children: [],
    } as const;

    addCreated(node, parent?.id ?? null);
    if (parent !== null) setExpanded((current) => new Set([...current, parent.id]));
    onSelect({
      type: node.type,
      id: node.id,
      title: node.title,
      path: parent === null ? [] : [...parent.path, parent.title],
    });
    close();
  };

  return (
    <Sheet
      className="px-5"
      keyboardAvoiding
      label="the destination picker"
      onClose={close}
      snapHeight={620}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton className="bg-primary-soft" icon={X} label="Close" onPress={close} />}
        subtitle={
          selected === null
            ? 'Pick an area or a project. Raphael will not choose one for you.'
            : `Filing in ${selected.title}. Tap another row to change that.`
        }
        title="Where does this go?"
        trailing={<View className="w-11" />}
      />

      <SheetBody className="mt-4" contentContainerStyle={{ paddingBottom: 12 }}>
        {creating === null ? (
          <>
            <SearchField
              accessibilityLabel="Filter areas and projects"
              onChangeText={setFilter}
              onClear={() => {
                setFilter('');
              }}
              placeholder="Find an area or project"
              value={filter}
            />

            <View className="mt-3">
              {visibleTree.length === 0 ? (
                <View className="flex-row items-center gap-2 py-4">
                  <Search color={colors.inkSoft} size={18} />
                  <Text className="font-body text-[15px] text-ink-soft">Nothing matches that.</Text>
                </View>
              ) : (
                <MockTree
                  expandedIds={expanded}
                  forceExpanded={needle !== ''}
                  nodes={visibleTree}
                  onSelect={(destination) => {
                    onSelect(destination);
                    close();
                  }}
                  onToggle={toggle}
                  selected={selected}
                />
              )}
            </View>

            <View className="mt-4 gap-2 border-t border-line pt-4">
              <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
                {selected?.type === 'area'
                  ? `Not there yet? Make one inside ${selected.title}.`
                  : 'Not there yet? Make a top-level area, or pick an area first to make something inside it.'}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Chip
                  icon={Plus}
                  label="New area"
                  onPress={() => {
                    setCreating('area');
                  }}
                />
                {selected?.type === 'area' ? (
                  <Chip
                    icon={Plus}
                    label="New project"
                    onPress={() => {
                      setCreating('project');
                    }}
                  />
                ) : null}
              </View>
            </View>
          </>
        ) : (
          <View className="gap-4">
            <Text className="font-heading text-[20px] leading-[26px] text-ink">
              New {creating}
              {selected?.type === 'area' ? ` in ${selected.title}` : ''}
            </Text>
            <TextInput
              accessibilityLabel={`${creating} title`}
              autoFocus
              className="font-heading text-[22px] leading-[28px] text-ink"
              onChangeText={setNewTitle}
              placeholder="Title"
              placeholderTextColor={colors.inkSoft}
              value={newTitle}
            />
            <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
              The {creating} is created on your server right away, whether or not this note is
              saved.
            </Text>
            <View className="flex-row items-center justify-between">
              <Chip
                label="Back to the list"
                onPress={() => {
                  setCreating(null);
                }}
              />
              <SavePill
                disabled={newTitle.trim() === ''}
                label="Create and file here"
                onPress={create}
              />
            </View>
          </View>
        )}
      </SheetBody>
    </Sheet>
  );
}
