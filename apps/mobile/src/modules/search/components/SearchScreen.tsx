import { describeQueryRejection } from '@raphael/contracts/nodes';
import { ChevronLeft, SlidersHorizontal } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import {
  Chip,
  emblemFor,
  IconButton,
  PressableFeedback,
  Screen,
  SearchField,
  SectionError,
  SectionHeading,
} from '../../../ui';
import { CollectionTile, containerTitleLookup, useHierarchy } from '../../collections';
import {
  ARCHIVED_LEFT_OUT_SENTENCE,
  INCLUDE_ARCHIVED_HINT,
  INCLUDE_ARCHIVED_LABEL,
} from '../../lifecycle';
import { goBack, leaveSearchFor, leaveSearchForNote } from '../../navigation';
import { NoteGrid } from '../../resources';
import type {
  ContainerResultItem,
  SearchDescriptor,
  SearchTypeFilter,
} from '../client/requests.ts';
import { SEARCH_LIMIT } from '../client/requests.ts';
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

/** One breath: fade to soft and back. Slow enough to read as waiting, not blinking. */
const PULSE_DURATION = 900;
const PULSE_LOW = 0.45;

export interface SearchScreenProps {
  /** Limits the search to one container subtree. Everything is searched when absent. */
  scope?: ContainerRef | null | undefined;
}

/** A quiet sentence on the canvas, for states that are not content. */
function Line({ children, className }: { children: string; className?: string }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      className={['font-body text-[15px] leading-[22px] text-ink-soft', className ?? ''].join(' ')}
    >
      {children}
    </Text>
  );
}

/** "Searching…" with a slow pulse while the server looks. Under reduced motion it holds still. */
function SearchingText() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    // Cancelled rather than merely not started. Reduced motion can be turned on while this screen
    // is open, and an early return alone would leave the pulse it had already started running.
    if (reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;

      return;
    }

    opacity.value = withRepeat(
      withTiming(PULSE_LOW, { duration: PULSE_DURATION, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(opacity);
    };
  }, [reducedMotion, opacity]);

  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text
      accessibilityLiveRegion="polite"
      className="font-body text-[15px] leading-[22px] text-ink-soft"
      style={pulse}
    >
      Searching…
    </Animated.Text>
  );
}

function ContainerSection({
  heading,
  items,
}: {
  heading: string;
  items: readonly ContainerResultItem[];
}) {
  return (
    <View className="gap-3">
      <SectionHeading>{heading}</SectionHeading>
      {items.map((item, index) => (
        <CollectionTile
          description={item.description}
          emblem={emblemFor(item.ref.type, item.ref.id)}
          key={item.ref.id}
          archived={item.archived}
          name={item.title}
          onPress={() => {
            leaveSearchFor(item.ref);
          }}
          waveSeed={index}
        />
      ))}
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
      <Line>{ARCHIVED_LEFT_OUT_SENTENCE}</Line>
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
 * The modal search screen: one field, one request, and the results grouped under three headings.
 *
 * The screen is a thin view over one page of server results. It asks once and never pages - a
 * fuller answer is a narrower search, and the cap is said out loud when there is one. It never
 * reorders within a group: relevance is the server's answer, and `groupSearchResults` only decides
 * which heading a hit sits under.
 *
 * Two distinctions it exists to keep. "Could not search" is not "nothing matched": one is a fact
 * about the server and the other a claim about someone's data, and they read identically to code
 * that only knows the request is over. And a scope that is gone does not quietly widen the search:
 * the person is told, and clearing the scope is an action they take.
 *
 * The hierarchy is read for two presentation details only - the container title in the placeholder
 * and the location eyebrow on a note card. A hierarchy that did not load costs exactly those two
 * things and nothing else; no search state is derived from it.
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

  const { view, refresh, isRefreshing } = useSearchResults(descriptor);

  const tree = useHierarchy();
  const titleOf = containerTitleLookup(tree);
  const scopeTitle = effectiveScope === null ? undefined : titleOf(effectiveScope.id);

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
  const { groups } = view;
  const hasResults =
    groups.areas.length > 0 || groups.projects.length > 0 || groups.notes.length > 0;

  return (
    <Screen
      captureBar={false}
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
            <Line>
              Titles, descriptions and note text all count. Nothing is searched until you do.
            </Line>
          ) : null
        ) : view.invalid !== undefined ? (
          <Line>
            {view.invalid.source === 'tags'
              ? describeTagsRejection(view.invalid.rejection)
              : describeQueryRejection(view.invalid.rejection)}
          </Line>
        ) : scopeGone && effectiveScope !== null ? (
          <View className="gap-3">
            <Line>{`That ${effectiveScope.type} is no longer here.`}</Line>
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
          <SearchingText />
        ) : unavailable ? (
          <SectionError onRetry={refresh} retrying={isRefreshing} title="Search did not answer." />
        ) : view.isEmpty ? (
          // The filters are named when any are on. "Nothing matches" on its own is a claim about
          // everything they have, and it would be false about the half this search excluded.
          <View className="gap-4">
            <Line>
              {filterActive
                ? `Nothing matches “${query}” with these filters.`
                : `Nothing matches “${query}”.`}
            </Line>
            {leftOut}
          </View>
        ) : hasResults ? (
          <View className="gap-4">
            <View className="gap-7">
              {groups.areas.length > 0 ? (
                <ContainerSection heading="Areas" items={groups.areas} />
              ) : null}
              {groups.projects.length > 0 ? (
                <ContainerSection heading="Projects" items={groups.projects} />
              ) : null}
              {groups.notes.length > 0 ? (
                <View className="gap-3">
                  <SectionHeading>Notes</SectionHeading>
                  <NoteGrid
                    items={groups.notes}
                    locationFor={titleOf}
                    markArchived
                    onOpen={leaveSearchForNote}
                  />
                </View>
              ) : null}
            </View>
            {view.isCapped ? (
              <Line>{`Showing the first ${String(SEARCH_LIMIT)}. Narrow the search to see the rest.`}</Line>
            ) : null}
            {leftOut}
          </View>
        ) : null}

        {/* Under whatever the body is showing, because a refresh can fail over an empty answer as
            readily as over a full one, and "nothing matched" alone would then be a claim made from a
            reading that is no longer current. It names a reading rather than results for the same
            reason: over an empty page there are none, and the collections module says it this way
            too. */}
        {view.isStale ? (
          <Line>Search could not be refreshed. This is the last reading.</Line>
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
