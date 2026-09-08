import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import type {
  Collection,
  Resource,
  SearchResults,
  SearchScope,
} from '../../../infrastructure/api/contracts';
import {
  EmptyState,
  IconButton,
  Screen,
  SearchField,
  SectionError,
  SectionHeading,
} from '../../../ui';
import { useLocationPath, CollectionTile } from '../../collections';
import { goBack, leaveSearchFor } from '../../navigation';
import { ResourceGrid, type ResourceGridItem } from '../../resources';
import { useSearch } from '../client/queries';

/** Long enough that a fast typist runs one search, short enough to feel immediate. */
const DEBOUNCE_MS = 150;

export interface SearchScreenProps {
  /** Limits the search to one collection subtree. Everything is searched when absent. */
  scope?: SearchScope | undefined;
}

/** Voice cards need the full width, and a lone card looks stranded in one column. */
function toGridItems(resources: readonly Resource[]): ResourceGridItem[] {
  return resources.map((resource) =>
    resource.kind === 'voice' || resources.length === 1
      ? { resource, span: 'full' as const }
      : { resource },
  );
}

/** Which of the mutually exclusive things the body is currently showing. */
type Status = 'idle' | 'loading' | 'failed' | 'empty' | 'results';

interface ResultGroupsProps {
  results: SearchResults;
  onOpenCollection: (collection: Collection) => void;
}

/** Results grouped the way the content is kept: places first, then what is inside them. */
function ResultGroups({ results, onOpenCollection }: ResultGroupsProps) {
  return (
    <View className="mt-5 gap-7">
      {results.collections.length > 0 ? (
        <View className="gap-4">
          <SectionHeading>Areas &amp; projects</SectionHeading>
          {results.collections.map((collection, index) => (
            <CollectionTile
              description={collection.description}
              emblem={collection.emblem}
              key={`${collection.type}-${collection.id}`}
              name={collection.name}
              onPress={() => {
                onOpenCollection(collection);
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

/** The modal search screen: one field, a scope line, and results grouped the way they are kept. */
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

  // The scope name comes from the location path; an id that resolves to nothing is not a scope.
  const { data: path } = useLocationPath(scope);
  const scopeName = path === undefined ? undefined : path[path.length - 1]?.name;
  const scopeMissing = scope !== null && path !== undefined && path.length === 0;
  const effectiveScope = scopeMissing ? null : scope;

  const { data, isPending, isError, isFetching, isPlaceholderData, refetch } = useSearch(
    query,
    effectiveScope,
  );

  // Refining a query keeps the previous results on screen. They are dimmed while the next ones
  // arrive, so the list never looks like a confident answer to what is in the field.
  const stale = isFetching && isPlaceholderData;

  const status: Status =
    query === ''
      ? 'idle'
      : isError
        ? 'failed'
        : isPending || data === undefined
          ? 'loading'
          : data.collections.length === 0 && data.resources.length === 0
            ? 'empty'
            : 'results';

  const scopeLine =
    scope === null
      ? 'Searching everything'
      : scopeMissing
        ? `That ${scope.type} is no longer here. Searching everything instead.`
        : scopeName === undefined
          ? `Searching in this ${scope.type}`
          : `Searching in ${scopeName}`;

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

      {status === 'idle' ? (
        <EmptyState
          className="mt-5"
          description="Names and summaries both count. Nothing is searched until you do."
          title="Start typing."
        />
      ) : status === 'loading' ? (
        <Text
          accessibilityLiveRegion="polite"
          className="mt-5 font-body text-[14px] leading-[20px] text-ink-soft"
        >
          Searching…
        </Text>
      ) : status === 'failed' ? (
        <View className="mt-5">
          <SectionError
            onRetry={() => {
              void refetch();
            }}
            retrying={isFetching}
            title="Search failed."
          />
        </View>
      ) : status === 'empty' ? (
        <EmptyState
          className="mt-5"
          description="Try a shorter word. The search reads titles and summaries, and nothing else."
          title={`Nothing matches “${query}”.`}
        />
      ) : status === 'results' && data !== undefined ? (
        <View className={stale ? 'opacity-60' : ''}>
          {stale ? (
            <Text
              accessibilityLiveRegion="polite"
              className="mt-5 font-body text-[14px] leading-[20px] text-ink-soft"
            >
              Searching…
            </Text>
          ) : null}
          <ResultGroups onOpenCollection={leaveSearchFor} results={data} />
        </View>
      ) : null}
    </Screen>
  );
}
