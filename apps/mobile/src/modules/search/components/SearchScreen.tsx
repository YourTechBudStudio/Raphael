import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import type { ContainerRef } from '../../../infrastructure/api/contracts';
import { emblemFor, IconButton, Screen, SearchField, SectionHeading } from '../../../ui';
import {
  CollectionTile,
  HierarchyError,
  HierarchyStale,
  type HierarchyNode,
} from '../../collections';
import { goBack, leaveSearchFor } from '../../navigation';
import { useSearch, type SearchResults } from '../client/results';

/** Long enough that a fast typist runs one search, short enough to feel immediate. */
const DEBOUNCE_MS = 150;

/**
 * The one honest statement about notes. Server-side search is a later story, and until it
 * arrives a search that quietly returns no notes would read as "you have no such note".
 */
const NOTES_LINE = 'Notes are not searched yet. Open an area or project to find one.';

export interface SearchScreenProps {
  /** Limits the search to one container subtree. Everything is searched when absent. */
  scope?: ContainerRef | null | undefined;
}

interface ResultGroupsProps {
  results: SearchResults;
  onOpenContainer: (ref: ContainerRef) => void;
}

function ResultGroups({ results, onOpenContainer }: ResultGroupsProps) {
  return (
    <View className="mt-5 gap-4">
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
  );
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

/**
 * The modal search screen: one field, a scope line, and the areas and projects that match.
 *
 * Containers are filtered out of the loaded hierarchy. Notes are not searched at all until
 * server-side search exists, and the screen says so rather than returning an empty list that
 * looks like an answer. "The hierarchy did not load" and "nothing matches" stay apart, because
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
  const empty = results.containers.length === 0;

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
            accessibilityLabel="Search areas and projects"
            autoFocus
            className="flex-1"
            onChangeText={setText}
            onClear={() => {
              setText('');
            }}
            placeholder="Find an area or project"
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
        <Line className="mt-5">
          Names and descriptions both count. Nothing is searched until you do.
        </Line>
      ) : (
        <View>
          {search.containersFailed ? (
            <View className="mt-5">
              <HierarchyError
                title="Areas and projects could not be searched — the hierarchy did not load."
                tree={search.tree}
              />
            </View>
          ) : null}

          <HierarchyStale className="mt-5" tree={search.tree} />

          {/* A failed hierarchy shows nothing below its error. Falling through to the results group
              would put an "Areas & projects" heading with nothing under it directly beneath the
              error, which reads as a completed search that found none. */}
          {search.isPending ? (
            <Line className="mt-5">Searching…</Line>
          ) : search.containersFailed ? null : empty ? (
            <Line className="mt-5">{`No area or project matches “${query}”. ${NOTES_LINE}`}</Line>
          ) : (
            <ResultGroups onOpenContainer={leaveSearchFor} results={results} />
          )}

          {/* Under whatever came back, so a full list of places never implies the notes were
              looked at too. */}
          {!search.isPending && !empty ? <Line className="mt-5">{NOTES_LINE}</Line> : null}
        </View>
      )}
    </Screen>
  );
}
