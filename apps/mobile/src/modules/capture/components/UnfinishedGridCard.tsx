import { Text } from 'react-native';

import { NoteCardShell } from '../../resources';
import { displayTitle, EYEBROW, isAlarming } from '../copy.ts';
import type { UnfinishedNote } from '../unfinished.ts';
import { since } from '../when.ts';

export interface UnfinishedGridCardProps {
  note: UnfinishedNote;
  /** Sampled once per render by the screen, so a grid of cards reads one clock. */
  now: number;
  onOpen?: (() => void) | undefined;
  testID?: string | undefined;
}

/** The verb that fits what happened to this note, so the line under the title is not generic. */
const verbFor = (note: UnfinishedNote): string => {
  switch (note.status) {
    case 'draft':
      return 'Edited';
    case 'unrecorded_success':
    case 'remainder':
      return 'Created';
    case 'inconsistent':
      return 'Last touched';
    default:
      return 'Sent';
  }
};

/**
 * A note that is only on this phone, as a card in Home's grid.
 *
 * The same card as a saved note, drawn by the same shell, because they are the same thing at
 * different stages and a person scanning the grid should not have to learn two shapes. What differs
 * is the eyebrow - a status where a saved note carries its location - and a draft's dotted edge,
 * which is the same mark the ghost "New area" row uses for something that is not there yet.
 *
 * Status is never carried by colour alone: every one of them is a phrase.
 */
export function UnfinishedGridCard({ note, now, onOpen, testID }: UnfinishedGridCardProps) {
  const eyebrow = EYEBROW[note.status];
  const title = displayTitle(note.title);
  const line = `${verbFor(note)} ${since(note.activityAt, now)}`;

  return (
    <NoteCardShell
      accessibilityLabel={`${eyebrow}. ${title}. ${line}`}
      // The same mark the ghost "New area" row uses: something that is not there yet.
      className={note.status === 'draft' ? 'border border-dotted border-lilac' : undefined}
      description={line}
      eyebrow={
        <Text
          className={`font-body-medium text-[14px] ${isAlarming(note.status) ? 'text-danger' : 'text-ink-soft'}`}
          numberOfLines={1}
        >
          {eyebrow}
        </Text>
      }
      onPress={onOpen}
      testID={testID}
      title={title}
    />
  );
}
