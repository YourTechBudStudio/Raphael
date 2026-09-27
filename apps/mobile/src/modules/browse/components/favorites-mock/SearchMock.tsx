/**
 * Temporary: favorites mock for story #14. Search without grouping: one ranked list of areas,
 * projects and notes in the candidate shared row, loading more as you scroll.
 */

import { ChevronLeft, SlidersHorizontal } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import {
  Chip,
  colors,
  IconButton,
  PressableFeedback,
  Screen,
  SearchField,
  SectionError,
  Snackbar,
} from '../../../../ui';
import { ARCHIVED_RESULTS, parentOf, SEARCH_PAGE, SEARCH_RESULTS } from './mock-data';
import { MockControls } from './MockControls';
import { MockRow, MockRowList } from './MockRow';
import { PulseLine, StateLine as Line } from './StateLine';

type SearchState = 'results' | 'searching' | 'none' | 'error';
type NextPage = 'ok' | 'fail';

export interface SearchMockProps {
  onBack: () => void;
}

export function SearchMock({ onBack }: SearchMockProps) {
  const [text, setText] = useState('plan');
  const [searchState, setSearchState] = useState<SearchState>('results');
  const [nextPage, setNextPage] = useState<NextPage>('ok');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [pages, setPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // A new query starts from the first page.
  useEffect(() => {
    setPages(1);
    setMoreFailed(false);
    setLoadingMore(false);
  }, [text, includeArchived]);

  const results = includeArchived
    ? SEARCH_RESULTS
    : SEARCH_RESULTS.filter((item) => !ARCHIVED_RESULTS.has(item.id));
  const shown = results.slice(0, pages * SEARCH_PAGE);
  const hasMore = shown.length < results.length;
  const showingResults = text.trim() !== '' && searchState === 'results';

  const loadMore = () => {
    if (!showingResults || !hasMore || loadingMore || moreFailed) return;
    setLoadingMore(true);
    timer.current = setTimeout(() => {
      setLoadingMore(false);
      if (nextPage === 'fail') setMoreFailed(true);
      else setPages((current) => current + 1);
    }, 800);
  };

  const body =
    text.trim() === '' ? (
      <Line>Titles, descriptions and note text all count. Nothing is searched until you do.</Line>
    ) : searchState === 'searching' ? (
      <PulseLine>Searching…</PulseLine>
    ) : searchState === 'error' ? (
      <SectionError
        onRetry={() => {
          setSearchState('results');
        }}
        title="Search did not answer."
      />
    ) : searchState === 'none' ? (
      <Line>{`Nothing matches “${text.trim()}”.`}</Line>
    ) : (
      <View className="gap-4">
        <MockRowList>
          {shown.map((item) => (
            <MockRow
              item={item}
              key={`${item.kind}-${String(item.id)}`}
              onPress={() => {
                setOpened(`Opens ${item.title}. Not part of this mock.`);
              }}
              archived={ARCHIVED_RESULTS.has(item.id)}
              parent={parentOf(item)}
            />
          ))}
        </MockRowList>
        {loadingMore ? (
          <View className="flex-row items-center justify-center gap-2 py-2">
            <ActivityIndicator color={colors.primary} size="small" />
            <Line>Loading more</Line>
          </View>
        ) : moreFailed ? (
          <View className="gap-2">
            <Line>More results did not load.</Line>
            <View className="flex-row">
              <Chip
                label="Retry"
                onPress={() => {
                  setMoreFailed(false);
                  setLoadingMore(true);
                  timer.current = setTimeout(() => {
                    setLoadingMore(false);
                    setPages((current) => current + 1);
                  }, 800);
                }}
              />
            </View>
          </View>
        ) : hasMore ? null : includeArchived ? (
          <Line>That is everything that matches.</Line>
        ) : (
          // As Search does today: said only when an archived match was left out.
          <View className="gap-1">
            <Line>Archived matches are left out.</Line>
            <PressableFeedback
              accessibilityLabel="Include archived"
              accessibilityRole="button"
              className="min-h-11 justify-center self-start pr-2"
              onPress={() => {
                setIncludeArchived(true);
              }}
              treatment="button"
            >
              <Text className="font-body-medium text-[15px] text-primary">Include archived</Text>
            </PressableFeedback>
          </View>
        )}
      </View>
    );

  return (
    <View style={{ flex: 1 }}>
      <Screen
        captureBar={false}
        header={
          <View className="flex-row items-center gap-3 pb-2">
            <IconButton icon={ChevronLeft} label="Back" onPress={onBack} />
            <SearchField
              accessibilityLabel="Search"
              className="flex-1"
              onChangeText={setText}
              onClear={() => {
                setText('');
              }}
              placeholder="Search everything"
              value={text}
            />
            {/* Inert here: the real filters (type, archived, tags) stay as they are. */}
            <IconButton icon={SlidersHorizontal} label="Filters" />
          </View>
        }
        onEndReached={loadMore}
      >
        {body}
      </Screen>
      <MockControls
        groups={[
          {
            title: 'Archived',
            options: [
              { key: 'out', label: 'Left out' },
              { key: 'in', label: 'Included' },
            ],
            value: includeArchived ? 'in' : 'out',
            onChange: (key) => {
              setIncludeArchived(key === 'in');
            },
          },
          {
            title: 'Search',
            options: [
              { key: 'results', label: 'Results' },
              { key: 'searching', label: 'Searching' },
              { key: 'none', label: 'Nothing matches' },
              { key: 'error', label: 'Did not answer' },
            ],
            value: searchState,
            onChange: (key) => {
              setSearchState(key as SearchState);
            },
          },
          {
            title: 'Next page',
            options: [
              { key: 'ok', label: 'Loads' },
              { key: 'fail', label: 'Fails' },
            ],
            value: nextPage,
            onChange: (key) => {
              setNextPage(key as NextPage);
            },
          },
        ]}
        note="Any query returns the same invented ranking, 12 per page. Scroll to the end to load the next page. Include archived to see the Archived pill on four results. Search rows have no star."
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
