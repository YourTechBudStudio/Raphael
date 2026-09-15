/**
 * THROWAWAY MOCK. Home's notes: the masonry grid the boards had, server-ordered newest first,
 * growing as you scroll. A tap opens the note in the editor.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native';

import type { NoteResource, VoiceResource } from '../../../infrastructure/api/contracts';
import { SectionHeading } from '../../../ui';
import type { ResourceGridItem } from '../../resources';
import { ResourceGrid } from '../../resources';
import { noteToResource, type MockDraft } from '../data';
import { useMockStore } from '../state';

/**
 * One voice note, so the grid is seen carrying a full-width card beside the notes. Voice capture
 * is not part of this story; the card is the existing session-only one, and it opens nothing.
 */
const VOICE_SAMPLE: VoiceResource = {
  kind: 'voice',
  id: 'voice-sample',
  title: 'Thoughts on the tile colour',
  summary: 'Recorded outside the showroom',
  parent: { type: 'project', id: 103 },
  createdAt: '',
  durationSeconds: 47,
  waveform: [
    0.2, 0.5, 0.8, 0.6, 0.3, 0.7, 0.9, 0.5, 0.4, 0.6, 0.8, 0.3, 0.2, 0.5, 0.7, 0.9, 0.6, 0.4, 0.3,
    0.6, 0.8, 0.5, 0.3, 0.2,
  ],
};

const DRAFT_PREFIX = 'draft-';

const rank = (draft: MockDraft): number =>
  draft.kind === 'unconfirmed' ? 0 : draft.kind === 'refused' ? 1 : 2;

/** Frozen: an unfinished note is a card in the grid, its status where the location would be. */
const draftToResource = (draft: MockDraft): NoteResource => ({
  kind: 'note',
  id: `${DRAFT_PREFIX}${String(draft.id)}`,
  title: draft.title === '' ? 'Untitled note' : draft.title,
  summary: draft.when,
  parent: { type: 'area', id: 0 },
  createdAt: '',
  location: draft.destination?.title,
  status: draft.kind,
});

export interface RecentNotesProps {
  onOpen: (id: number) => void;
  onOpenDraft: (id: number) => void;
}

export function MockRecentNotes({ onOpen, onOpenDraft }: RecentNotesProps) {
  const notes = useMockStore((state) => state.notes);
  const drafts = useMockStore((state) => state.drafts);
  const shown = useMockStore((state) => state.shown);
  const homeNotes = useMockStore((state) => state.homeNotes);
  const items = useMemo<ResourceGridItem[]>(() => {
    // Unfinished notes lead the grid, and the ones waiting on a decision lead those: a save with
    // no answer, then a refused save, then drafts that simply have not been saved yet.
    // Drafts for another server are not this Home's: they wait on the Unfinished screen.
    const unfinished: ResourceGridItem[] = drafts
      .filter((draft) => draft.endpoint === undefined)
      .sort((a, b) => rank(a) - rank(b))
      .map((draft) => ({ resource: draftToResource(draft) }));
    const saved = homeNotes === 'many' ? notes.slice(0, shown) : [];
    const cards: ResourceGridItem[] = [
      ...unfinished,
      ...saved.map((note) => ({ resource: noteToResource(note) })),
    ];
    // After the first saved note, full width, the way the board opens with a voice card.
    if (saved.length > 0) {
      cards.splice(Math.min(unfinished.length + 1, cards.length), 0, {
        resource: VOICE_SAMPLE,
        span: 'full',
      });
    }

    return cards;
  }, [drafts, homeNotes, notes, shown]);

  return (
    <View className="gap-3">
      <SectionHeading>Notes</SectionHeading>
      {/* Said in one line, like the other sections. The unfinished cards still show above a
          failure, because they are on this phone whatever the server is doing. */}
      {homeNotes === 'failed' ? (
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-[15px] leading-[22px] text-ink-soft"
        >
          Unable to load notes. Pull down to try again.
        </Text>
      ) : items.length === 0 ? (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
          No notes yet. Whatever is on your mind goes in with New note, and can find its place
          later.
        </Text>
      ) : null}
      <ResourceGrid
        items={items}
        noteVariant="lilac"
        onPressResource={(resource) => {
          if (resource.kind !== 'note') return;
          if (resource.id.startsWith(DRAFT_PREFIX)) {
            onOpenDraft(Number(resource.id.slice(DRAFT_PREFIX.length)));
          } else {
            onOpen(Number(resource.id));
          }
        }}
      />
    </View>
  );
}
