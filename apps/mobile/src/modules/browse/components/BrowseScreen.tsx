import { Layers, Plus, Star } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { BrowseNode, ParentRef } from '../../../infrastructure/api/contracts';
import {
  EmptyState,
  IconButton,
  PressableFeedback,
  Screen,
  SearchField,
  SectionError,
  colors,
} from '../../../ui';
import { UnresolvedAttempts, useBrowseTree, useLocationPath } from '../../collections';
import { goBack, openCollection, TitleTopBar, useSheetsStore } from '../../navigation';
import { useBrowseStore } from '../state/tree';
import { BrowseTree } from './BrowseTree';
import { FavoritesList } from './FavoritesList';
import { filterTree } from './tree';

/**
 * The root holds areas and nothing else. Creating one is the single creation Browse offers,
 * because the root is the only container without a screen of its own; everything inside an area
 * is made from that area's screen. Creation is rare, so it is one quiet icon rather than a row.
 */
const ROOT_AREA = { type: 'area', parentAreaId: null } as const;

type Tab = 'all' | 'favorites';

export interface BrowseScreenProps {
  /** The location Browse was opened from, highlighted as current. Null when opened from Home. */
  current: ParentRef | null;
}

/**
 * Browse: the whole area and project tree, with the location it was opened from marked as
 * current. Tapping a row pushes that location, so back from it returns here.
 */
export function BrowseScreen({ current }: BrowseScreenProps) {
  const expanded = useBrowseStore((state) => state.expanded);
  const toggle = useBrowseStore((state) => state.toggle);
  const expandMany = useBrowseStore((state) => state.expandMany);
  const openNewContainer = useSheetsStore((state) => state.openNewContainer);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
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

  const tree = useBrowseTree();
  const { data: path } = useLocationPath(current);

  // The current location and everything above it opens, so the highlight is on screen.
  useEffect(() => {
    if (path !== undefined) {
      expandMany(path.map((step) => step.id));
    }
  }, [path, expandMany]);

  const filtering = query.trim() !== '';
  const nodes = useMemo(() => filterTree(tree.data ?? [], query), [tree.data, query]);

  const select = (node: ParentRef) => {
    if (current !== null && current.type === node.type && current.id === node.id) {
      goBack();

      return;
    }

    openCollection(node);
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
              <TitleTopBar
                onBack={goBack}
                title="Browse"
                trailing={
                  <IconButton
                    accessibilityHint="Opens a sheet to name a new area at the top level"
                    icon={Plus}
                    label="New top-level area"
                    onPress={() => {
                      openNewContainer(ROOT_AREA);
                    }}
                    testID="browse-new-area"
                  />
                }
              />
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
          {tab === 'all' ? <UnresolvedAttempts className="mb-3" parentAreaId={null} /> : null}
          {tab === 'favorites' ? (
            <FavoritesList onSelect={select} query={query} />
          ) : (
            <TreeBody
              current={current}
              expandedIds={expanded}
              filtering={filtering}
              isError={tree.isError}
              isPending={tree.isPending}
              nodes={nodes}
              onRetry={() => {
                void tree.refetch();
              }}
              onSelect={select}
              onToggle={toggle}
              retrying={tree.isFetching}
            />
          )}
        </Screen>
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
  nodes: readonly BrowseNode[];
  /** The node Browse was opened from, or null when opened from Home. */
  current: ParentRef | null;
  expandedIds: ReadonlySet<string>;
  filtering: boolean;
  isPending: boolean;
  isError: boolean;
  retrying: boolean;
  onRetry: () => void;
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
  retrying,
  onRetry,
  onToggle,
  onSelect,
}: TreeBodyProps) {
  if (isError) {
    return (
      <SectionError
        onRetry={onRetry}
        retrying={retrying}
        title="Areas and projects did not load."
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
        description="Nothing here matches that. Try a shorter word."
        title="No areas or projects."
      />
    ) : (
      <EmptyState
        description="Areas and projects show up here once you make one. The plus above makes the first."
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
