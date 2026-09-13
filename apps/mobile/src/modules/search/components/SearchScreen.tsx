import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef, Resource } from '../../../infrastructure/api/contracts';
import {
  emblemFor,
  EmptyState,
  IconButton,
  Screen,
  SearchField,
  SectionHeading,
} from '../../../ui';
import {
  CollectionTile,
  HierarchyError,
  HierarchyStale,
  type HierarchyNode,
} from '../../collections';
import { goBack, leaveSearchFor } from '../../navigation';
import { ResourceGrid, type ResourceGridItem } from '../../resources';
import { useSearch, type SearchResults } from '../client/results';

/** Long enough that a fast typist runs one search, short enough to feel immediate. */
const DEBOUNCE_MS = 150;

export interface SearchScreenProps {
  /** Limits the search to one container subtree. Everything is searched when absent. */
  scope?: ContainerRef | null | undefined;
}

/** Voice cards need the full width, and a lone card looks stranded in one column. */
function toGridItems(resources: readonly Resource[]): ResourceGridItem[] {
  return resources.map((resource) =>
    resource.kind === 'voice' || resources.length === 1
      ? { resource, span: 'full' as const }
      : { resource },
  );
}

interface ResultGroupsProps {
  results: SearchResults;
  onOpenContainer: (ref: ContainerRef) => void;
}

/** Results grouped the way the content is kept: places first, then what is inside them. */
function ResultGroups({ results, onOpenContainer }: ResultGroupsProps) {
  return (
    <View className="mt-5 gap-7">
      {results.containers.length > 0 ? (
        <View className="gap-4">
          <SectionHeading>Areas &amp; projects</SectionHeading>
          {results.containers.map((container: HierarchyNode, index) => (
            <CollectionTile
              description={container.description}
              emblem={emblemFor(container.type, container.id)}
              key={container.id}
              name={container.title}
              onPress={() => {
                onOpenContainer({ type: container.type, id: container.id });
              }}
              waveSeed={index}
            />
          ))}
        </View>
      ) : null}

      {results.resources.length > 0 ? (
        <View className="gap-4">
          <SectionHeading>Notes</SectionHeading>
          <ResourceGrid items={toGridItems(results.resources)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The modal search screen: one field, a scope line, and results grouped the way they are kept.
 *
 * Areas and projects are filtered out of the loaded hierarchy; notes are searched over what this
 * device is holding for the session. The two are kept apart in the failure states as well as in the
 * results, because "the hierarchy did not load" and "nothing matches" are different answers and
 * only one of them is about what the person was looking for.
 */
export function SearchScreen({ scope = null }: SearchScreenProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(text);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  const query = debounced.trim();
  const search = useSearch(query, scope);
  const { results } = search;
  const empty = results.containers.length === 0 && results.resources.length === 0;

  const scopeLine =
    scope === null
      ? 'Searching everything'
      : search.scopeMissing
        ? `That ${scope.type} is no longer here. Searching everything instead.`
        : search.scopeName === undefined
          ? `Searching in this ${scope.type}`
          : `Searching in ${search.scopeName}`;

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
            accessibilityLabel="Search notes, areas, and projects"
            autoFocus
            className="flex-1"
            onChangeText={setText}
            onClear={() => {
              setText('');
            }}
            placeholder="Find a note, area, or project"
            value={text}
          />
        </View>
      }
      testID="search-screen"
    >
      <Text
        accessibilityLiveRegion="polite"
        className="font-body text-[14px] leading-[20px] text-ink-soft"
      >
        {scopeLine}
      </Text>

      {query === '' ? (
        <EmptyState
          className="mt-5"
          description="Names and summaries both count. Nothing is searched until you do."
          title="Start typing."
        />
      ) : (
        <View>
          {/* Said above the results, not instead of them: notes may still have matched. */}
          {search.containersFailed ? (
            <View className="mt-5">
              <HierarchyError
                title="Areas and projects could not be searched — the hierarchy did not load."
                tree={search.tree}
              />
            </View>
          ) : null}

          <HierarchyStale className="mt-5" tree={search.tree} />

          {search.isPending ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-5 font-body text-[14px] leading-[20px] text-ink-soft"
            >
              Searching…
            </Text>
          ) : empty && !search.containersFailed ? (
            <EmptyState
              className="mt-5"
              description="Try a shorter word. The search reads titles, descriptions, and summaries, and nothing else."
              title={`Nothing matches “${query}”.`}
            />
          ) : (
            <ResultGroups onOpenContainer={leaveSearchFor} results={results} />
          )}
        </View>
      )}
    </Screen>
  );
}
