/**
 * Temporary: favorites mock for story #14. Browse → Favorites as one flat list of the shared
 * two-line row, ordered by title.
 */

import { Layers, Star } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import {
  Chip,
  colors,
  PressableFeedback,
  Screen,
  SearchField,
  SectionError,
  Snackbar,
} from '../../../../ui';
import { TitleTopBar } from '../../../navigation';
import { favoriteItems, INITIAL_FAVORITES, parentOf } from './mock-data';
import { MockControls } from './MockControls';
import { MockRow, MockRowList } from './MockRow';
import { PulseLine, StateLine } from './StateLine';

type ListState = 'populated' | 'empty' | 'loading' | 'error' | 'stale';
type NextTap = 'ok' | 'slow' | 'fail';

const FAILED = 'Favorite did not update. Try again.';

export interface FavoritesMockProps {
  onBack: () => void;
}

export function FavoritesMock({ onBack }: FavoritesMockProps) {
  const [listState, setListState] = useState<ListState>('populated');
  const [nextTap, setNextTap] = useState<NextTap>('ok');
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<ReadonlySet<number>>(new Set(INITIAL_FAVORITES));
  // Unstarred rows still on screen until the list refreshes.
  const [lingering, setLingering] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const later = (ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  };
  const withId = (set: ReadonlySet<number>, id: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);

    return next;
  };

  const toggle = (id: number) => {
    if (busy.has(id)) return;
    const wanted = !favorites.has(id);
    const outcome = nextTap;
    setBusy((current) => withId(current, id, true));
    setFailed((current) => withId(current, id, false));

    later(outcome === 'slow' ? 2200 : 600, () => {
      setBusy((current) => withId(current, id, false));
      if (outcome === 'fail') {
        setFailed((current) => withId(current, id, true));

        return;
      }
      setFavorites((current) => withId(current, id, wanted));
      setLingering((current) => withId(current, id, !wanted));
      // The refetch the mutation starts lands a moment later and drops the row.
      if (!wanted) {
        later(700, () => {
          setLingering((current) => withId(current, id, false));
        });
      }
    });
  };

  const visible = useMemo(() => new Set([...favorites, ...lingering]), [favorites, lingering]);
  const needle = query.trim().toLowerCase();
  const rows = favoriteItems(visible).filter((item) => item.title.toLowerCase().includes(needle));

  const body =
    listState === 'loading' ? (
      <PulseLine>Loading favorites…</PulseLine>
    ) : listState === 'error' ? (
      <SectionError
        onRetry={() => {
          setListState('populated');
        }}
        title="Favorites did not load."
      />
    ) : listState === 'empty' || (needle === '' && rows.length === 0) ? (
      <StateLine>No favorites yet. Star an area or project to keep a shortcut here.</StateLine>
    ) : rows.length === 0 ? (
      <StateLine>{`No favorite matches “${query.trim()}”.`}</StateLine>
    ) : (
      <View className="gap-3">
        {listState === 'stale' ? (
          <View className="gap-2">
            <StateLine>Favorites may be out of date. The last refresh did not load.</StateLine>
            <View className="flex-row">
              <Chip
                label="Retry"
                onPress={() => {
                  setListState('populated');
                }}
              />
            </View>
          </View>
        ) : null}
        <MockRowList>
          {rows.map((item) => (
            <MockRow
              failure={failed.has(item.id) ? FAILED : null}
              item={item}
              key={item.id}
              onPress={() => {
                setOpened(`Opens ${item.title}. Not part of this mock.`);
              }}
              parent={parentOf(item)}
              star={{
                favorited: favorites.has(item.id),
                busy: busy.has(item.id),
                onToggle: () => {
                  toggle(item.id);
                },
              }}
            />
          ))}
        </MockRowList>
      </View>
    );

  return (
    <View style={{ flex: 1 }}>
      <Screen
        captureBar={false}
        header={
          <View className="gap-3 pb-1">
            <TitleTopBar onBack={onBack} title="Browse" />
            <MockTabs />
            <SearchField
              accessibilityLabel="Filter favorites"
              onChangeText={setQuery}
              onClear={() => {
                setQuery('');
              }}
              placeholder="Find a favorite"
              value={query}
            />
          </View>
        }
      >
        {body}
      </Screen>
      <MockControls
        groups={[
          {
            title: 'List',
            options: [
              { key: 'populated', label: 'Loaded' },
              { key: 'empty', label: 'Empty' },
              { key: 'loading', label: 'Loading' },
              { key: 'error', label: 'Did not load' },
              { key: 'stale', label: 'Refresh failed' },
            ],
            value: listState,
            onChange: (key) => {
              setListState(key as ListState);
            },
          },
          {
            title: 'Next star tap',
            options: [
              { key: 'ok', label: 'Succeeds' },
              { key: 'slow', label: 'Slow' },
              { key: 'fail', label: 'Fails' },
            ],
            value: nextTap,
            onChange: (key) => {
              setNextTap(key as NextTap);
            },
          },
        ]}
        note="Unstar a row: the star empties, then the row fades out when the list refreshes. Slow shows the busy ring."
      />
      <Snackbar
        message={opened}
        onHidden={() => {
          setOpened(null);
        }}
      />
    </View>
  );
}

/** The Browse pill switch, drawn with Favorites selected. All is inert in the mock. */
function MockTabs() {
  return (
    <View accessibilityRole="tablist" className="flex-row gap-2 rounded-full bg-card p-1">
      {(['all', 'favorites'] as const).map((value) => {
        const selected = value === 'favorites';
        const Icon = value === 'all' ? Layers : Star;

        return (
          <PressableFeedback
            accessibilityLabel={value === 'all' ? 'All' : 'Favorites'}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={`h-12 flex-row items-center justify-center gap-2 rounded-full ${selected ? 'bg-wave' : ''}`}
            hitSlop={0}
            key={value}
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
