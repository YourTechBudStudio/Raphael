/**
 * THROWAWAY MOCK — presentation only, for story #6 UI exploration. Delete before merging.
 *
 * No requests are made. The state strip at the bottom picks which screen state is drawn, the
 * scope chip toggles between "everything" and one project, and the type chips filter the fixture
 * so the mixed ranked list can be judged with real tiles and cards.
 */
import { ChevronLeft, Plus, SlidersHorizontal, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import {
  Chip,
  emblemFor,
  IconButton,
  Screen,
  SearchField,
  SectionError,
  SectionHeading,
  Sheet,
  SheetHeader,
} from '../../../ui';
import { CollectionTile } from '../../collections';
import { goBack } from '../../navigation';
import { NoteGrid, type NoteSummaryItem } from '../../resources';

const DEBOUNCE_MS = 300;

type TypeFilter = 'all' | 'area' | 'project' | 'note';

type MockState =
  | 'results'
  | 'loading'
  | 'empty'
  | 'invalid'
  | 'scopeGone'
  | 'unavailable'
  | 'stale'
  | 'capped';

const STATES: readonly { key: MockState; label: string }[] = [
  { key: 'results', label: 'Results' },
  { key: 'loading', label: 'Loading' },
  { key: 'empty', label: 'Empty' },
  { key: 'invalid', label: 'Invalid query' },
  { key: 'scopeGone', label: 'Scope gone' },
  { key: 'unavailable', label: 'Unavailable' },
  { key: 'stale', label: 'Stale' },
  { key: 'capped', label: 'Capped at 100' },
];

const SCOPE_NAME = 'Raphael launch';

const TYPE_CHIPS: readonly { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'area', label: 'Areas' },
  { key: 'project', label: 'Projects' },
  { key: 'note', label: 'Notes' },
];

type Hit =
  | { kind: 'container'; type: 'area' | 'project'; id: number; title: string; description: string }
  | { kind: 'note'; note: NoteSummaryItem; location: string };

const note = (id: number, title: string, description: string, location: string): Hit => ({
  kind: 'note',
  location,
  note: {
    id,
    title,
    description,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    revision: 1,
    parentId: 1,
  },
});

/** Relevance order as the server would return it: mixed on purpose, never grouped. */
const HITS: readonly Hit[] = [
  {
    kind: 'container',
    type: 'project',
    id: 12,
    title: 'Authentication rework',
    description: 'Move sessions to signed tokens and rotate the credential store.',
  },
  note(
    41,
    'Credential rotation runbook',
    'Steps for rotating the API key without downtime.',
    'Authentication rework',
  ),
  note(
    58,
    'Why we dropped basic auth',
    'Decision record with the two incidents that pushed it.',
    'Backend',
  ),
  { kind: 'container', type: 'area', id: 3, title: 'Security', description: '' },
  note(63, 'Auth flow sketch', '', 'Authentication rework'),
  {
    kind: 'container',
    type: 'project',
    id: 17,
    title: 'Mobile login screen',
    description: 'Biometric unlock and the key paste flow.',
  },
  note(
    77,
    'Meeting: credentials audit',
    'Findings from the quarterly review, mostly boring, one not.',
    'Security',
  ),
];

/** One breath: fade to soft and back. Slow enough to read as waiting, not blinking. */
const PULSE_DURATION = 900;
const PULSE_LOW = 0.45;

/** "Searching…" with a slow pulse while the server looks. Under reduced motion it holds still. */
function SearchingText() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(
      withTiming(PULSE_LOW, { duration: PULSE_DURATION, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
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

interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  type: TypeFilter;
  onType: (type: TypeFilter) => void;
  tags: readonly string[];
  onTags: (tags: readonly string[]) => void;
}

/** Type and tag filters, kept off the search header and opened from one icon beside the field. */
function FilterSheet({ visible, onClose, type, onType, tags, onTags }: FilterSheetProps) {
  const [entry, setEntry] = useState('');

  const addTag = () => {
    const tag = entry.trim().toLowerCase();
    setEntry('');
    if (tag === '' || tags.includes(tag)) return;
    onTags([...tags, tag]);
  };

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      keyboardAvoiding
      label="the filter sheet"
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={onClose} />}
        subtitle="Narrow the search. Applied as you change them."
        title="Filters"
        trailing={<View className="w-11" />}
      />
      <View className="gap-3">
        <SectionHeading>Show</SectionHeading>
        <View className="flex-row flex-wrap gap-2">
          {TYPE_CHIPS.map((chip) => (
            <Chip
              key={chip.key}
              label={chip.label}
              onPress={() => {
                onType(chip.key);
              }}
              selected={type === chip.key}
            />
          ))}
        </View>
      </View>
      <View className="gap-3">
        <SectionHeading>Tags</SectionHeading>
        <View className="flex-row flex-wrap gap-2">
          {tags.map((tag) => (
            <Chip
              accessibilityHint="Removes this tag from the filter"
              accessibilityLabel={`Remove tag ${tag}`}
              key={tag}
              label={tag}
              onPress={() => {
                onTags(tags.filter((item) => item !== tag));
              }}
              trailingIcon={X}
            />
          ))}
          {tags.length === 0 ? (
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              Any tag. Add one to narrow it down.
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel="Tag to filter by"
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            className="h-11 flex-1 rounded-full bg-card px-4 font-body text-[16px] text-ink"
            onChangeText={setEntry}
            onSubmitEditing={addTag}
            placeholder="Add a tag"
            returnKeyType="done"
            value={entry}
          />
          <IconButton disabled={entry.trim() === ''} icon={Plus} label="Add tag" onPress={addTag} />
        </View>
      </View>
    </Sheet>
  );
}

function ResultList({ hits }: { hits: readonly Hit[] }) {
  const areas = hits.filter((hit) => hit.kind === 'container' && hit.type === 'area');
  const projects = hits.filter((hit) => hit.kind === 'container' && hit.type === 'project');
  const notes = hits.filter((hit) => hit.kind === 'note');
  const locations = new Map(notes.map((hit) => [hit.note.parentId, hit.location]));

  const tiles = (group: readonly Hit[]) =>
    group.map((hit, index) =>
      hit.kind === 'container' ? (
        <CollectionTile
          description={hit.description}
          emblem={emblemFor(hit.type, hit.id)}
          key={`c${String(hit.id)}`}
          name={hit.title}
          onPress={() => {}}
          waveSeed={index}
        />
      ) : null,
    );

  return (
    <View className="gap-7">
      {areas.length > 0 ? (
        <View className="gap-3">
          <SectionHeading>Areas</SectionHeading>
          {tiles(areas)}
        </View>
      ) : null}
      {projects.length > 0 ? (
        <View className="gap-3">
          <SectionHeading>Projects</SectionHeading>
          {tiles(projects)}
        </View>
      ) : null}
      {notes.length > 0 ? (
        <View className="gap-3">
          <SectionHeading>Notes</SectionHeading>
          <NoteGrid
            items={notes.map((hit) => hit.note)}
            locationFor={(parentId) => locations.get(parentId)}
            onOpen={() => {}}
          />
        </View>
      ) : null}
    </View>
  );
}

export function MockSearchScreen() {
  const [text, setText] = useState('credentials');
  const [debounced, setDebounced] = useState('credentials');
  const [type, setType] = useState<TypeFilter>('all');
  const [tags, setTags] = useState<readonly string[]>([]);
  const [scoped, setScoped] = useState(true);
  const [state, setState] = useState<MockState>('results');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterActive = type !== 'all' || tags.length > 0;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(text);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  const query = debounced.trim();
  const idle = query === '';

  const hits = HITS.filter((hit) => {
    if (type === 'all') return true;
    if (type === 'note') return hit.kind === 'note';

    return hit.kind === 'container' && hit.type === type;
  });

  const showsList = state === 'results' || state === 'stale' || state === 'capped';

  // The scope is said once, in the empty field, and nowhere else.
  const placeholder = scoped ? `Search in ${SCOPE_NAME}` : 'Find anything';

  return (
    <Screen
      captureBar={false}
      header={
        <View className="pb-2">
          <View className="flex-row items-center gap-3">
            <IconButton icon={ChevronLeft} label="Back" onPress={goBack} />
            <SearchField
              accessibilityLabel="Search"
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
              accessibilityHint="Opens type and tag filters"
              filled={filterActive}
              icon={SlidersHorizontal}
              label={filterActive ? 'Filters, active' : 'Filters'}
              onPress={() => {
                setFiltersOpen(true);
              }}
            />
          </View>
        </View>
      }
      testID="mock-search-screen"
    >
      <View>
        {idle ? (
          <Line>
            Titles, descriptions and note text all count. Nothing is searched until you do.
          </Line>
        ) : state === 'invalid' ? (
          <Line>AND and OR need a word on both sides.</Line>
        ) : state === 'loading' ? (
          <SearchingText />
        ) : state === 'unavailable' ? (
          <SectionError onRetry={() => {}} title="Search did not answer." />
        ) : state === 'scopeGone' && scoped ? (
          <View className="gap-3">
            <Line>That project is no longer here.</Line>
            <View className="flex-row">
              <Chip
                accessibilityHint="Clears the scope and searches everything"
                label="Search everything"
                onPress={() => {
                  setScoped(false);
                  setState('results');
                }}
              />
            </View>
          </View>
        ) : state === 'empty' || hits.length === 0 ? (
          <Line>{`Nothing matches “${query}”.`}</Line>
        ) : showsList ? (
          <View className="gap-4">
            <ResultList hits={hits} />
            {state === 'stale' ? (
              <Line>Search could not be refreshed. These are the last results.</Line>
            ) : null}
            {state === 'capped' ? (
              <Line>Showing the first 100. Narrow the search to see the rest.</Line>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Mock controls. Not part of the design. */}
      <View className="mt-10 gap-3 rounded-card border border-line bg-card-warm px-4 py-3">
        <Text className="font-body-medium text-[13px] uppercase tracking-wide text-ink-soft">
          Mock controls
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Chip
            label={scoped ? 'Opened from a project' : 'Opened from Home'}
            onPress={() => {
              setScoped((value) => !value);
            }}
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          {STATES.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              onPress={() => {
                setState(item.key);
              }}
              selected={state === item.key}
            />
          ))}
        </View>
      </View>

      <FilterSheet
        onClose={() => {
          setFiltersOpen(false);
        }}
        onTags={setTags}
        onType={setType}
        tags={tags}
        type={type}
        visible={filtersOpen}
      />
    </Screen>
  );
}
