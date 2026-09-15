import { Layers, Star } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { EmptyState, PressableFeedback, Screen, SearchField, colors } from '../../../ui';
import {
  ancestorsOf,
  HierarchyError,
  HierarchyStale,
  PendingSummary,
  useHierarchy,
  type HierarchyNode,
  type HierarchyQuery,
} from '../../collections';
import { RejectionNotice } from '../../connection';
import { mockHierarchyRoots, useMockStore } from '../../mock';
import { goBack, openContainer, openRecovery, TitleTopBar, useSheetsStore } from '../../navigation';
import { useBrowseStore } from '../state/tree';
import { AddInsideSheet } from './AddInsideSheet';
import { BrowseTree } from './BrowseTree';
import { FavoritesList } from './FavoritesList';
import { filterTree } from './tree';

type Tab = 'all' | 'favorites';

/** Long enough for the add sheet's exit before the creation sheet's modal takes the window. */
const CHOICE_CLOSE_MS = 240;

export interface BrowseScreenProps {
  /** The location Browse was opened from, highlighted as current. Null when opened from Home. */
  current: ContainerRef | null;
}

/**
 * Browse: the whole area and project tree, with the location it was opened from marked as current.
 * Tapping a row pushes that location, so back from it returns here.
 *
 * Creating containers happens from here: a plus on every area row makes an area or a project inside
 * it, and a dashed "New area" row at the end of the root makes a top-level area.
 *
 * The filter runs over exactly what is loaded, and what is loaded is the complete hierarchy or
 * nothing at all - so "no areas or projects" here is a statement about the server, not about how
 * far a paginated read happened to get.
 */
export function BrowseScreen({ current }: BrowseScreenProps) {
  const expanded = useBrowseStore((state) => state.expanded);
  const toggle = useBrowseStore((state) => state.toggle);
  const expandMany = useBrowseStore((state) => state.expandMany);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [adding, setAdding] = useState<HierarchyNode | null>(null);
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

  const tree = useHierarchy();
  const openNewContainer = useSheetsStore((state) => state.openNewContainer);
  const ancestorIds = useMemo(
    () => ancestorsOf(tree.hierarchy, current?.id ?? null).map((step) => step.id),
    [tree.hierarchy, current],
  );

  // The current location and everything above it opens, so the highlight is on screen.
  useEffect(() => {
    if (ancestorIds.length > 0) expandMany(ancestorIds);
  }, [ancestorIds, expandMany]);

  const filtering = query.trim() !== '';
  // THROWAWAY: the gallery can swap the server's hierarchy for the mock one, so the nesting can
  // be seen on a server that has little in it.
  const mockBrowse = useMockStore((state) => state.mockBrowse);
  const created = useMockStore((state) => state.created);
  const roots = useMemo(
    () => (__DEV__ && mockBrowse ? mockHierarchyRoots(created) : (tree.hierarchy?.roots ?? [])),
    [mockBrowse, created, tree.hierarchy],
  );
  const nodes = useMemo(() => filterTree(roots, query), [roots, query]);

  const select = (node: ContainerRef) => {
    if (current !== null && current.type === node.type && current.id === node.id) {
      goBack();

      return;
    }

    openContainer(node);
  };

  const selectTab = (value: Tab) => {
    setTab(value);
    setQuery('');
  };

  return (
    <GestureDetector gesture={swipe}>
      {/* The detector needs a real native view under it; a flattened one would drop the gesture. */}
      <View collapsable={false} style={{ flex: 1 }}>
        <Screen
          captureBar={false}
          header={
            <View className="gap-3 pb-1">
              <TitleTopBar onBack={goBack} title="Browse" />
              <Tabs onSelect={selectTab} tab={tab} />
              <SearchField
                accessibilityLabel={
                  tab === 'all' ? 'Filter areas and projects' : 'Filter favorites'
                }
                onChangeText={setQuery}
                onClear={() => {
                  setQuery('');
                }}
                placeholder={tab === 'all' ? 'Find an area or project' : 'Find a favorite'}
                value={query}
              />
            </View>
          }
          testID="browse-screen"
        >
          <RejectionNotice className="mb-3" />
          {/* An attempt aimed at the root belongs to no area, which is why the summary is here:
              Home carries it as well, and between them there is nowhere it can hide. */}
          {tab === 'favorites' ? null : (
            <View className="mb-4">
              <PendingSummary onOpen={openRecovery} parentAreaId={null} />
            </View>
          )}
          {tab === 'favorites' ? (
            <FavoritesList onSelect={select} query={query} />
          ) : (
            <TreeBody
              current={current}
              expandedIds={expanded}
              filtering={filtering}
              hasHierarchy={tree.hierarchy !== undefined || (__DEV__ && mockBrowse)}
              isPending={tree.isPending && !(__DEV__ && mockBrowse)}
              nodes={nodes}
              onAdd={setAdding}
              onAddRoot={() => {
                openNewContainer('area', null);
              }}
              onSelect={select}
              onToggle={toggle}
              tree={tree}
            />
          )}
        </Screen>
        <AddInsideSheet
          area={adding}
          onClose={() => {
            setAdding(null);
          }}
          onPick={(type, area) => {
            setAdding(null);
            // The creation sheet is its own modal; it opens once this one has left the screen.
            setTimeout(() => {
              openNewContainer(type, area.id);
            }, CHOICE_CLOSE_MS);
          }}
        />
      </View>
    </GestureDetector>
  );
}

interface TabsProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
}

/** All and Favorites, as a pill switch that a horizontal swipe on the list also drives. */
function Tabs({ tab, onSelect }: TabsProps) {
  return (
    <View accessibilityRole="tablist" className="flex-row gap-2 rounded-full bg-card p-1">
      {(['all', 'favorites'] as const).map((value) => {
        const selected = tab === value;
        const Icon = value === 'all' ? Layers : Star;

        return (
          <PressableFeedback
            accessibilityLabel={value === 'all' ? 'All' : 'Favorites'}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={`h-12 flex-row items-center justify-center gap-2 rounded-full ${selected ? 'bg-wave' : ''}`}
            hitSlop={0}
            key={value}
            onPress={() => {
              onSelect(value);
            }}
            style={{ flex: 1 }}
          >
            <Icon color={selected ? colors.primary : colors.inkSoft} size={20} />
            <Text className="font-body-semibold text-[16px] text-ink">
              {value === 'all' ? 'All' : 'Favorites'}
            </Text>
          </PressableFeedback>
        );
      })}
    </View>
  );
}

interface TreeBodyProps {
  nodes: readonly HierarchyNode[];
  /** The node Browse was opened from, or null when opened from Home. */
  current: ContainerRef | null;
  expandedIds: ReadonlySet<number>;
  filtering: boolean;
  hasHierarchy: boolean;
  isPending: boolean;
  tree: HierarchyQuery;
  onToggle: (id: number) => void;
  onSelect: (node: HierarchyNode) => void;
  onAdd: (node: HierarchyNode) => void;
  onAddRoot: () => void;
}

/** The tree, or an honest account of why it is not there. */
function TreeBody({
  nodes,
  current,
  expandedIds,
  filtering,
  hasHierarchy,
  isPending,
  tree,
  onToggle,
  onSelect,
  onAdd,
  onAddRoot,
}: TreeBodyProps) {
  // A failed refresh over a hierarchy that did load keeps the tree and says so. Blanking it would
  // throw away a complete reading because the next one was interrupted.
  if (tree.isError && !hasHierarchy) {
    return <HierarchyError title="Areas and projects did not load." tree={tree} />;
  }

  if (isPending || !hasHierarchy) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator accessibilityLabel="Loading areas and projects" color={colors.primary} />
      </View>
    );
  }

  return (
    <View className="gap-3">
      <HierarchyStale tree={tree} />

      {nodes.length === 0 && filtering ? (
        <EmptyState
          description="Nothing here matches that. Try a shorter word."
          title="No areas or projects."
        />
      ) : (
        <BrowseTree
          current={current}
          expandedIds={expandedIds}
          forceExpanded={filtering}
          nodes={nodes}
          onAdd={onAdd}
          // The virtual row is a place, not a match: it stays out of a filtered list.
          onAddRoot={filtering ? undefined : onAddRoot}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      )}
    </View>
  );
}
