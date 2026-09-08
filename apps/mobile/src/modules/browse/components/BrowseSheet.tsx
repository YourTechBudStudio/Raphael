import { Layers, Star } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { BrowseNode, ParentRef } from '../../../infrastructure/api/contracts';
import {
  EmptyState,
  SearchField,
  Sheet,
  SheetHeader,
  PressableFeedback,
  colors,
} from '../../../ui';
import { useBrowseTree, useLocationPath } from '../../collections';
import { openCollection, useSheetsStore } from '../../navigation';
import { useBrowseStore } from '../state/tree';
import { BrowseTree } from './BrowseTree';
import { FavoritesList } from './FavoritesList';
import { filterTree } from './tree';

/** Shown when Browse is opened from Home, where there is no current location. */
const HOME_SUBTITLE = 'Areas & projects';

/**
 * The global Browse sheet: the whole area and project tree, with the location it was opened
 * from marked as current. Tapping a row navigates there and closes the sheet.
 */
export function BrowseSheet() {
  const open = useSheetsStore((state) => state.open);
  const current = useSheetsStore((state) => state.browseCurrent);
  const close = useSheetsStore((state) => state.close);
  const expanded = useBrowseStore((state) => state.expanded);
  const toggle = useBrowseStore((state) => state.toggle);
  const expandMany = useBrowseStore((state) => state.expandMany);

  const visible = open === 'browse';
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'favorites'>('all');
  const { height } = useWindowDimensions();
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-24, 24])
        .failOffsetY([-16, 16])
        .runOnJS(true)
        .onEnd((event) => {
          if (Math.abs(event.translationX) > 50) {
            setTab(event.translationX < 0 ? 'favorites' : 'all');
            setQuery('');
          }
        }),
    [],
  );

  const { data: tree, isPending, isError } = useBrowseTree();
  const { data: path } = useLocationPath(current);

  // A fresh open starts with the whole tree, not the last filter.
  useEffect(() => {
    if (visible) {
      setQuery('');
      setTab('all');
    }
  }, [visible]);

  // The current location and everything above it opens, so the highlight is on screen.
  useEffect(() => {
    if (!visible || path === undefined) {
      return;
    }

    expandMany(path.map((step) => step.id));
  }, [visible, path, expandMany]);

  const filtering = query.trim() !== '';
  const nodes = useMemo(() => filterTree(tree ?? [], query), [tree, query]);

  // While the path is still loading there is nothing honest to say about where you are, so the
  // subtitle stays out rather than claiming the Home context.
  const subtitle =
    current === null
      ? HOME_SUBTITLE
      : path === undefined || path.length === 0
        ? undefined
        : path.map((step) => step.name).join(' / ');

  const select = (node: ParentRef) => {
    if (current !== null && current.type === node.type && current.id === node.id) {
      close();
      return;
    }

    openCollection({ type: node.type, id: node.id });
    close();
  };

  return (
    <Sheet
      className="px-5"
      keyboardAvoiding
      label="Browse"
      onClose={close}
      visible={visible}
      snapHeight={height * 0.8}
    >
      <SheetHeader onClose={close} subtitle={subtitle} title="Browse" />
      <View accessibilityRole="tablist" className="mt-4 flex-row gap-2 rounded-full bg-canvas p-1">
        {(['all', 'favorites'] as const).map((value) => {
          const selected = tab === value;
          const Icon = value === 'all' ? Layers : Star;
          return (
            <PressableFeedback
              key={value}
              accessibilityRole="tab"
              accessibilityLabel={value === 'all' ? 'All' : 'Favorites'}
              accessibilityState={{ selected }}
              className={`h-12 flex-row items-center justify-center gap-2 rounded-full ${selected ? 'bg-wave' : ''}`}
              hitSlop={0}
              style={{ flex: 1 }}
              onPress={() => {
                setTab(value);
                setQuery('');
              }}
            >
              <Icon color={selected ? colors.primary : colors.inkSoft} size={20} />
              <Text className="font-body-semibold text-[16px] text-ink">
                {value === 'all' ? 'All' : 'Favorites'}
              </Text>
            </PressableFeedback>
          );
        })}
      </View>
      <SearchField
        className="mt-4"
        onChangeText={setQuery}
        onClear={() => {
          setQuery('');
        }}
        accessibilityLabel={tab === 'all' ? 'Filter areas and projects' : 'Filter favorites'}
        placeholder={tab === 'all' ? 'Find an area or project' : 'Find a favorite'}
        value={query}
      />
      <GestureDetector gesture={swipe}>
        <ScrollView
          key={tab}
          className="mt-3"
          contentContainerStyle={{ paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
          style={{ flexShrink: 1 }}
        >
          {tab === 'favorites' ? (
            <FavoritesList query={query} onSelect={select} />
          ) : (
            <TreeBody
              current={current}
              expandedIds={expanded}
              filtering={filtering}
              isError={isError}
              isPending={isPending}
              nodes={nodes}
              onSelect={select}
              onToggle={toggle}
            />
          )}
        </ScrollView>
      </GestureDetector>
    </Sheet>
  );
}

interface TreeBodyProps {
  nodes: readonly BrowseNode[];
  /** The node the sheet was opened from, or null when opened from Home. */
  current: ParentRef | null;
  expandedIds: ReadonlySet<string>;
  filtering: boolean;
  isPending: boolean;
  isError: boolean;
  onToggle: (id: string) => void;
  onSelect: (node: BrowseNode) => void;
}

/** The tree, or an honest account of why it is not there. */
function TreeBody({
  nodes,
  current,
  expandedIds,
  filtering,
  isPending,
  isError,
  onToggle,
  onSelect,
}: TreeBodyProps) {
  if (isError) {
    return (
      <EmptyState
        className="mt-2"
        description="Reading your areas and projects failed. Close Browse and open it again."
        title="Could not load the tree."
      />
    );
  }

  if (isPending) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator accessibilityLabel="Loading areas and projects" color={colors.primary} />
      </View>
    );
  }

  if (nodes.length === 0) {
    return filtering ? (
      <EmptyState
        className="mt-2"
        description="Nothing here matches that. Try a shorter word."
        title="No areas or projects."
      />
    ) : (
      <EmptyState
        className="mt-2"
        description="Areas and projects show up here once you make one."
        title="Nothing to browse yet."
      />
    );
  }

  return (
    <BrowseTree
      current={current}
      expandedIds={expandedIds}
      forceExpanded={filtering}
      nodes={nodes}
      onSelect={onSelect}
      onToggle={onToggle}
    />
  );
}
