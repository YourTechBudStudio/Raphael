/**
 * Temporary: archive mock for story #8. Search as the only way back to archived material.
 *
 * Results come from the same invented world the other screens change, so archiving the project there
 * removes it here until "Include archived" is on. Opening an archived hit lands on its screen, where
 * the Archive toggle restores it.
 */

import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Layers,
  SlidersHorizontal,
  X,
} from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import {
  Card,
  Chip,
  colors,
  Emblem,
  emblemFor,
  IconButton,
  Screen,
  SearchField,
  SectionHeading,
  Sheet,
  SheetHeader,
} from '../../../../ui';
import { NoteCardShell } from '../../../resources';
import { isArchived, type MockNode, type MockWorld, NODES } from './mock-state';

export interface SearchMockProps {
  world: MockWorld;
  onBack: () => void;
  onOpen: (node: MockNode) => void;
}

type Hit =
  | {
      kind: 'container';
      type: 'area' | 'project';
      id: number;
      title: string;
      node: MockNode | null;
    }
  | {
      kind: 'note';
      id: number;
      title: string;
      description: string;
      location: string;
      node: MockNode | null;
    };

/** Relevance order, mixed on purpose. `node` ties a hit to the world; null hits never archive. */
const HITS: readonly Hit[] = [
  { kind: 'container', type: 'project', id: 12, title: NODES.project.title, node: 'project' },
  {
    kind: 'note',
    id: 41,
    title: NODES.note.title,
    description: 'Steps for rotating the API key without downtime.',
    location: NODES.project.title,
    node: 'note',
  },
  {
    kind: 'note',
    id: 58,
    title: 'Why we dropped basic auth',
    description: 'Decision record with the two incidents that pushed it.',
    location: 'Backend',
    node: null,
  },
  { kind: 'container', type: 'area', id: 3, title: 'Security', node: null },
];

function ArchivedPill() {
  return (
    <View className="flex-row items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5">
      <Archive color={colors.primary} size={13} strokeWidth={2} />
      <Text className="font-body-medium text-[13px] text-primary">Archived</Text>
    </View>
  );
}

export function SearchMock({ world, onBack, onOpen }: SearchMockProps) {
  const [text, setText] = useState('auth');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const archivedOf = (hit: Hit): boolean =>
    hit.node !== null && isArchived(world.standing(hit.node));
  const shown = HITS.filter((hit) => includeArchived || !archivedOf(hit));
  // What the server's `archivedLeftOut` would say: an archived node matched and was left out.
  const archivedLeftOut = shown.length < HITS.length;

  return (
    <View className="flex-1">
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
            <IconButton
              accessibilityHint="Opens type, tag and archive filters"
              filled={includeArchived}
              icon={SlidersHorizontal}
              label={includeArchived ? 'Filters, active' : 'Filters'}
              onPress={() => {
                setFiltersOpen(true);
              }}
            />
          </View>
        }
      >
        <View className="gap-3">
          {shown.map((hit) => {
            const archived = archivedOf(hit);
            const open = () => {
              if (hit.node !== null) onOpen(hit.node);
            };

            if (hit.kind === 'container') {
              return (
                <Card
                  accessibilityLabel={archived ? `${hit.title}, Archived` : hit.title}
                  className="justify-center px-4 py-3"
                  key={`c${String(hit.id)}`}
                  onPress={open}
                  wave
                  waveHeight={40}
                  waveSeed={hit.id}
                >
                  <View className="flex-row items-center gap-3">
                    <Emblem name={emblemFor(hit.type, hit.id)} size={36} />
                    <View className="flex-1">
                      <View className="min-h-11 flex-row items-center gap-2">
                        <Text
                          className="flex-1 font-heading text-[17px] leading-[22px] text-ink"
                          numberOfLines={1}
                        >
                          {hit.title}
                        </Text>
                        {archived ? <ArchivedPill /> : null}
                        <ChevronRight color={colors.ink} size={22} strokeWidth={2} />
                      </View>
                    </View>
                  </View>
                </Card>
              );
            }

            return (
              <NoteCardShell
                accessibilityLabel={`Note. ${archived ? 'Archived. ' : ''}${hit.title}. ${hit.description}. In ${hit.location}`}
                description={hit.description}
                eyebrow={
                  <View className="flex-row items-center gap-1.5">
                    <Layers color={colors.primary} size={16} strokeWidth={2} />
                    <Text
                      className="flex-1 font-body-medium text-[14px] text-primary"
                      numberOfLines={1}
                    >
                      {hit.location}
                    </Text>
                    {archived ? <ArchivedPill /> : null}
                  </View>
                }
                key={`n${String(hit.id)}`}
                onPress={open}
                title={hit.title}
              />
            );
          })}

          {!includeArchived && archivedLeftOut ? (
            <Text className="mt-2 font-body text-[15px] leading-[22px] text-ink-soft">
              Archived matches are left out.{' '}
              <Text
                className="font-body-medium text-primary"
                onPress={() => {
                  setIncludeArchived(true);
                }}
              >
                Include archived
              </Text>
            </Text>
          ) : null}
        </View>
      </Screen>

      <Sheet
        className="gap-5 px-5 pb-6 pt-3"
        label="the filter sheet"
        onClose={() => {
          setFiltersOpen(false);
        }}
        visible={filtersOpen}
      >
        <SheetHeader
          leading={
            <IconButton
              icon={X}
              label="Close"
              onPress={() => {
                setFiltersOpen(false);
              }}
            />
          }
          subtitle="Narrow the search. Applied as you change them."
          title="Filters"
          trailing={<View className="w-11" />}
        />
        <View className="gap-3">
          <SectionHeading>Show</SectionHeading>
          <View className="flex-row flex-wrap gap-2">
            <Chip label="All" selected />
            <Chip label="Areas" />
            <Chip label="Projects" />
            <Chip label="Notes" />
          </View>
        </View>
        <View className="gap-3">
          <SectionHeading>Archived</SectionHeading>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              accessibilityHint="Adds archived areas, projects and notes to the results"
              icon={Archive}
              label="Include archived"
              onPress={() => {
                setIncludeArchived((current) => !current);
              }}
              selected={includeArchived}
            />
          </View>
        </View>
        <View className="gap-3">
          <SectionHeading>Tags</SectionHeading>
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            Any tag. Add one to narrow it down.
          </Text>
        </View>
      </Sheet>
    </View>
  );
}
