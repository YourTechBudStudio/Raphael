import { describeQueryRejection } from '@raphael/contracts/nodes';
import { Archive, ChevronLeft, SlidersHorizontal } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import {
  Chip,
  IconButton,
  ListRow,
  PressableFeedback,
  Screen,
  SearchField,
  SectionError,
  StateLine,
  WaitingLine,
  type ListRowParent,
} from '../../../ui';
import { containerLookup, useHierarchy } from '../../collections';
import {
  ARCHIVED_LABEL,
  ARCHIVED_LEFT_OUT_SENTENCE,
  INCLUDE_ARCHIVED_HINT,
  INCLUDE_ARCHIVED_LABEL,
} from '../../lifecycle';
import { goBack, leaveSearchFor, leaveSearchForNote } from '../../navigation';
import type { SearchDescriptor, SearchResultItem, SearchTypeFilter } from '../client/requests.ts';
import { useSearchResults } from '../client/results.ts';
import { describeTagsRejection } from './filter-copy';
import { FilterSheet } from './FilterSheet';

/**
 * Long enough that a fast typist runs one search, short enough to feel immediate.
 *
 * Twice what it was, because each keystroke now costs a request to the server rather than a pass
 * over a list already in memory.
 */
const DEBOUNCE_MS = 300;

/** The kind in a word, on each row's second line and in its spoken label. */
const KIND_LABELS: Record<SearchResultItem['type'], string> = {
  area: 'Area',
  project: 'Project',
  note: 'Note',
};

/** What pressing a row does, said once for each kind. */
const OPEN_HINTS: Record<SearchResultItem['type'], string> = {
  area: 'Opens this area',
  project: 'Opens this project',
  note: 'Opens this note',
};

export interface SearchScreenProps {
  /** Limits the search to one container subtree. Everything is searched when absent. */
  scope?: ContainerRef | null | undefined;
}

/** Leaves search for the row's own screen: a container where it lives, a note in the editor. */
const openResult = (item: SearchResultItem): void => {
  if (item.type === 'note') {
    leaveSearchForNote(item.id);

    return;
  }

  leaveSearchFor({ type: item.type, id: item.id });
};

/**
 * The end of the list while it is still being walked: waiting for the next page, or saying that it
 * did not come. A failed page keeps every row above it and never lets the list look finished.
 */
function MoreFooter({
  isLoadingMore,
  isMoreError,
  onRetry,
}: {
  isLoadingMore: boolean;
  isMoreError: boolean;
  onRetry: () => void;
}) {
  if (isLoadingMore) return <WaitingLine>Loading more…</WaitingLine>;

  if (!isMoreError) return null;

  return (
    <View className="gap-3" testID="more-failed">
      <StateLine>More results did not load.</StateLine>
      <View className="flex-row">
        <Chip accessibilityHint="Asks for the next results again" label="Retry" onPress={onRetry} />
      </View>
    </View>
  );
}

/**
 * The end of the results when the server says an archived node matched and was left out. Shown only
 * then, so pressing its button always adds something: Search is the only way back to archived
 * material on the phone, and someone who forgot the filter still learns something is hidden.
 */
function ArchivedLeftOut({ onInclude }: { onInclude: () => void }) {
  return (
    <View className="gap-1" testID="archived-left-out">
      <StateLine>{ARCHIVED_LEFT_OUT_SENTENCE}</StateLine>
      <PressableFeedback
        accessibilityHint={INCLUDE_ARCHIVED_HINT}
        accessibilityLabel={INCLUDE_ARCHIVED_LABEL}
        accessibilityRole="button"
        className="min-h-11 justify-center self-start pr-2"
        onPress={onInclude}
        testID="include-archived-inline"
        treatment="button"
      >
        <Text className="font-body-medium text-[15px] text-primary">{INCLUDE_ARCHIVED_LABEL}</Text>
      </PressableFeedback>
    </View>
  );
}

/**
 * The modal search screen: one field, and one list of results in the server's relevance order.
 *
 * The screen is a thin view over server pages. It asks for the first page when the query settles and
 * for the next as the end of the list scrolls into view, and it never reorders anything: relevance
 * is the server's answer. Every row is a `ListRow`, whatever its kind.
 *
 * Two distinctions it exists to keep. "Could not search" is not "nothing matched": one is a fact
 * about the server and the other a claim about someone's data, and they read identically to code
 * that only knows the request is over. And a scope that is gone does not quietly widen the search:
 * the person is told, and clearing the scope is an action they take.
 *
 * The hierarchy is read for two presentation details only - the container title in the placeholder
 * and the parent pill on a row. A hierarchy that did not load costs exactly those two things and
 * nothing else; no search state, row or order is derived from it.
 */
export function SearchScreen({ scope = null }: SearchScreenProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState<SearchTypeFilter>('all');
  const [tags, setTags] = useState<readonly string[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Local to this search, and deliberately not a rewrite of the route parameters: someone who
  // clears a gone scope has widened *this* search, not moved themselves in the hierarchy, so
  // reopening search from the same container scopes it again.
  const [scopeCleared, setScopeCleared] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(text);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  const effectiveScope = scopeCleared ? null : scope;
  const query = debounced.trim();

  const descriptor = useMemo(
    (): SearchDescriptor => ({ scope: effectiveScope, query, type, tags, includeArchived }),
    [effectiveScope, query, type, tags, includeArchived],
  );

  const { view, refresh, isRefreshing, loadMore, retryMore } = useSearchResults(descriptor);

  const tree = useHierarchy();
  const containerOf = containerLookup(tree);
  const scopeTitle = effectiveScope === null ? undefined : containerOf(effectiveScope.id)?.title;
  const parentOf = (parentId: number | null): ListRowParent | undefined => {
    const parent = parentId === null ? undefined : containerOf(parentId);

    return parent === undefined
      ? undefined
      : { kind: parent.type, id: parent.id, title: parent.title };
  };

  const placeholder =
    effectiveScope === null
      ? 'Find anything'
      : scopeTitle === undefined
        ? `Search in this ${effectiveScope.type}`
        : `Search in ${scopeTitle}`;

  const filterActive = type !== 'all' || tags.length > 0 || includeArchived;
  // Checked against the filter as well as the page, so a reading taken before it was turned on can
  // never offer to turn it on again.
  const leftOut =
    !includeArchived && view.archivedLeftOut ? (
      <ArchivedLeftOut
        onInclude={() => {
          setIncludeArchived(true);
        }}
      />
    ) : null;
  // A gone scope is only a sentence someone can act on while there is a scope to name and clear.
  // Reported against the root it would be an ordinary failed search, so it is drawn as one.
  const scopeGone = view.isScopeGone && effectiveScope !== null;
  const unavailable = view.isUnavailable || (view.isScopeGone && effectiveScope === null);

  return (
    <Screen
      captureBar={false}
      onEndReached={loadMore}
      header={
        <View className="flex-row items-center gap-3 pb-2">
          <IconButton
            accessibilityHint="Leaves search and returns to the previous screen"
            icon={ChevronLeft}
            label="Back"
            onPress={goBack}
          />
          <SearchField
            accessibilityLabel="Search"
            autoFocus
            className="flex-1"
            onChangeText={setText}
            onClear={() => {
              setText('');
            }}
            placeholder={placeholder}
            value={text}
          />
          {/* Fills violet while a filter is narrowing the search, so the header says so. */}
          <IconButton
            accessibilityHint="Opens type, archive and tag filters"
            filled={filterActive}
            icon={SlidersHorizontal}
            label={filterActive ? 'Filters, active' : 'Filters'}
            onPress={() => {
              setFiltersOpen(true);
            }}
          />
        </View>
      }
      testID="search-screen"
    >
      <View className="gap-4">
        {view.isIdle ? (
          // Only for a query nobody has started. An open quote is also idle - nothing is searched
          // while a phrase is unfinished - but this sentence would be false then, because the
          // person plainly is searching.
          query === '' ? (
            <StateLine>
              Titles, descriptions and note text all count. Nothing is searched until you do.
            </StateLine>
          ) : null
        ) : view.invalid !== undefined ? (
          <StateLine>
            {view.invalid.source === 'tags'
              ? describeTagsRejection(view.invalid.rejection)
              : describeQueryRejection(view.invalid.rejection)}
          </StateLine>
        ) : scopeGone && effectiveScope !== null ? (
          <View className="gap-3">
            <StateLine>{`That ${effectiveScope.type} is no longer here.`}</StateLine>
            <View className="flex-row">
              <Chip
                accessibilityHint="Clears the scope and searches everything"
                label="Search everything"
                onPress={() => {
                  setScopeCleared(true);
                }}
              />
            </View>
          </View>
        ) : view.isLoading ? (
          <WaitingLine>Searching…</WaitingLine>
        ) : unavailable ? (
          <SectionError onRetry={refresh} retrying={isRefreshing} title="Search did not answer." />
        ) : view.isEmpty ? (
          // The filters are named when any are on. "Nothing matches" on its own is a claim about
          // everything they have, and it would be false about the half this search excluded.
          <View className="gap-4">
            <StateLine>
              {filterActive
                ? `Nothing matches “${query}” with these filters.`
                : `Nothing matches “${query}”.`}
            </StateLine>
            {leftOut}
          </View>
        ) : view.items.length > 0 ? (
          <View className="gap-4">
            <View className="gap-0.5">
              {view.items.map((item) => (
                <ListRow
                  accessibilityHint={OPEN_HINTS[item.type]}
                  key={item.id}
                  kindLabel={KIND_LABELS[item.type]}
                  mark={{ kind: item.type, id: item.id }}
                  onPress={() => {
                    openResult(item);
                  }}
                  parent={parentOf(item.parentId)}
                  status={item.archived ? { icon: Archive, label: ARCHIVED_LABEL } : undefined}
                  testID="search-result"
                  title={item.title}
                />
              ))}
            </View>
            <MoreFooter
              isLoadingMore={view.isLoadingMore}
              isMoreError={view.isMoreError}
              onRetry={retryMore}
            />
            {/* It describes the whole match set, so it waits until the list has ended. */}
            {view.hasMore ? null : leftOut}
          </View>
        ) : null}

        {/* Under whatever the body is showing, because a refresh can fail over an empty answer as
            readily as over a full one, and "nothing matched" alone would then be a claim made from a
            reading that is no longer current. It names a reading rather than results for the same
            reason: over an empty page there are none, and the collections module says it this way
            too. */}
        {view.isStale ? (
          <StateLine>Search could not be refreshed. This is the last reading.</StateLine>
        ) : null}
      </View>

      <FilterSheet
        includeArchived={includeArchived}
        onClose={() => {
          setFiltersOpen(false);
        }}
        onIncludeArchived={setIncludeArchived}
        onTags={setTags}
        onType={setType}
        rejection={view.invalid?.source === 'tags' ? view.invalid.rejection : undefined}
        tags={tags}
        type={type}
        visible={filtersOpen}
      />
    </Screen>
  );
}
