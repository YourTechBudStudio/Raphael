/**
 * THROWAWAY MOCK. The entry to the capture mock, and the switch for what the fake server does.
 */

import { Text, View } from 'react-native';

import { Card, Chip, Screen, SectionHeading } from '../../../ui';
import {
  HOME_NOTES_LABEL,
  OUTCOME_LABEL,
  STORAGE_LABEL,
  useMockStore,
  type MockHomeNotes,
  type MockOutcome,
  type MockStorage,
} from '../state';

const OUTCOMES: readonly MockOutcome[] = ['saved', 'uncertain', 'refused'];
const STORAGES: readonly MockStorage[] = ['fine', 'write_failing', 'editor_refuses'];
const HOME_NOTES: readonly MockHomeNotes[] = ['many', 'none', 'failed'];

export interface MockGalleryProps {
  onBack: () => void;
  onOpen: () => void;
  onOpenUnfinished: () => void;
  onOpenSetup: () => void;
}

export function MockGallery({ onBack, onOpen, onOpenUnfinished, onOpenSetup }: MockGalleryProps) {
  const outcome = useMockStore((state) => state.outcome);
  const setOutcome = useMockStore((state) => state.setOutcome);
  const mockBrowse = useMockStore((state) => state.mockBrowse);
  const setMockBrowse = useMockStore((state) => state.setMockBrowse);
  const storage = useMockStore((state) => state.storage);
  const setStorage = useMockStore((state) => state.setStorage);
  const homeNotes = useMockStore((state) => state.homeNotes);
  const setHomeNotes = useMockStore((state) => state.setHomeNotes);
  const noteOpens = useMockStore((state) => state.noteOpens);
  const setNoteOpens = useMockStore((state) => state.setNoteOpens);

  return (
    <Screen captureBar={false}>
      <View className="flex-row">
        <Chip label="Back to Home" onPress={onBack} />
      </View>
      <SectionHeading className="mt-6">Capture mock</SectionHeading>
      <Text className="mt-2 font-body text-[15px] leading-[22px] text-ink-soft">
        Throwaway. Nothing here saves anything. Set the switches, then open the composer.
      </Text>

      <Card
        accessibilityHint="Opens the capture mock"
        accessibilityLabel="Open the composer"
        className="mt-5 px-4 py-4"
        onPress={onOpen}
        wave
        waveHeight={28}
      >
        <Text className="font-heading text-[18px] leading-[24px] text-ink">Open the composer</Text>
        <Text className="mt-1 pb-3 font-body text-[15px] leading-[21px] text-ink-soft">
          Title, description, body. Destination and Save pinned above the keyboard. Success returns
          to Home; a failure takes a sheet.
        </Text>
      </Card>

      <SectionHeading className="mt-8">When you press Save</SectionHeading>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {OUTCOMES.map((candidate) => (
          <Chip
            key={candidate}
            label={OUTCOME_LABEL[candidate]}
            onPress={() => {
              setOutcome(candidate);
            }}
            selected={candidate === outcome}
          />
        ))}
      </View>

      <SectionHeading className="mt-8">This phone's storage</SectionHeading>
      <Text className="mt-2 font-body text-[15px] leading-[22px] text-ink-soft">
        What the editor says when the writing is not yet safe on the phone, and what closing it does
        then.
      </Text>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {STORAGES.map((candidate) => (
          <Chip
            key={candidate}
            label={STORAGE_LABEL[candidate]}
            onPress={() => {
              setStorage(candidate);
            }}
            selected={candidate === storage}
          />
        ))}
      </View>

      <SectionHeading className="mt-8">Home's notes</SectionHeading>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {HOME_NOTES.map((candidate) => (
          <Chip
            key={candidate}
            label={HOME_NOTES_LABEL[candidate]}
            onPress={() => {
              setHomeNotes(candidate);
            }}
            selected={candidate === homeNotes}
          />
        ))}
      </View>

      <SectionHeading className="mt-8">Opening a saved note</SectionHeading>
      <View className="mt-3 flex-row flex-wrap gap-2">
        <Chip
          label="Body loads"
          onPress={() => {
            setNoteOpens(true);
          }}
          selected={noteOpens}
        />
        <Chip
          label="Body fails to load"
          onPress={() => {
            setNoteOpens(false);
          }}
          selected={!noteOpens}
        />
      </View>

      <SectionHeading className="mt-8">Without a connection</SectionHeading>
      <Text className="mt-2 font-body text-[15px] leading-[22px] text-ink-soft">
        The setup screen, with the unfinished notes this phone is holding under it.
      </Text>
      <View className="mt-3 flex-row">
        <Chip label="Open the setup screen" onPress={onOpenSetup} />
      </View>

      <SectionHeading className="mt-8">Unfinished notes</SectionHeading>
      <Text className="mt-2 font-body text-[15px] leading-[22px] text-ink-soft">
        They lead the Notes grid on Home, the ones waiting on you first. The screen below lists them
        with the unfinished areas and projects.
      </Text>
      <View className="mt-3 flex-row">
        <Chip label="Open Unfinished" onPress={onOpenUnfinished} />
      </View>

      <SectionHeading className="mt-8">Browse</SectionHeading>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {/* Search reads the same tree while this is on. */}
        <Chip
          label="Mock hierarchy"
          onPress={() => {
            setMockBrowse(true);
          }}
          selected={mockBrowse}
        />
        <Chip
          label="Your server's hierarchy"
          onPress={() => {
            setMockBrowse(false);
          }}
          selected={!mockBrowse}
        />
      </View>
    </Screen>
  );
}
