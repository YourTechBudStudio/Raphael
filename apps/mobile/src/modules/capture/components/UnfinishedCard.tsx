import { Text, View } from 'react-native';

import { Card, Chip, confirmDiscard } from '../../../ui';
import {
  discardPromptFor,
  displayTitle,
  EYEBROW,
  isAlarming,
  RETIRED_SENTENCE,
  sentenceFor,
} from '../copy.ts';
import type { UnfinishedAction, UnfinishedNote } from '../unfinished.ts';
import { since } from '../when.ts';

/**
 * What a host can do about one row.
 *
 * All optional: the projection already says which actions are performable, and a host that cannot
 * offer one - because there is nowhere to navigate, say - simply does not pass it.
 */
export interface UnfinishedActions {
  readonly open?: ((note: UnfinishedNote) => void) | undefined;
  readonly lookIn?: ((note: UnfinishedNote) => void) | undefined;
  readonly copy?: ((note: UnfinishedNote) => void) | undefined;
  readonly recordAgain?: ((note: UnfinishedNote) => void) | undefined;
  readonly discard?: ((note: UnfinishedNote) => void) | undefined;
  readonly dismiss?: ((note: UnfinishedNote) => void) | undefined;
}

export interface UnfinishedCardProps {
  note: UnfinishedNote;
  now: number;
  actions: UnfinishedActions;
  /** The destination's name, when the hierarchy can supply one. Never a stored copy. */
  destination?: string | undefined;
  testID?: string | undefined;
}

/**
 * One unfinished note on the recovery screen: what it is, in one sentence, and what can be done.
 *
 * The three classes here are deliberately not one row with a different colour. A save that may have
 * created something, a refusal holding writing someone can correct, and a draft nobody has sent are
 * three different situations with three different next steps, and flattening them would make the one
 * that needs attention look like the two that do not.
 *
 * Every destructive action is confirmed, and the confirmation says what it removes. Discarding an
 * unresolved note removes writing and keeps the evidence, because discarding writing cannot undo a
 * creation the server may already have made.
 */
export function UnfinishedCard({ note, now, actions, destination, testID }: UnfinishedCardProps) {
  const eyebrow = EYEBROW[note.status];
  const title = displayTitle(note.title);
  const offers = (action: UnfinishedAction): boolean => note.actions.includes(action);

  return (
    <Card className="gap-3 p-4" testID={testID}>
      <View className="gap-1">
        <Text
          className={`font-body-medium text-[14px] ${isAlarming(note.status) ? 'text-danger' : 'text-ink-soft'}`}
        >
          {eyebrow}
          {/* A row this build cannot read has no time it can honestly claim to have been touched. */}
          {note.status === 'unusable' ? '' : ` · ${since(note.activityAt, now)}`}
          {note.scope !== 'current' && note.endpoint !== '' ? ` · ${note.endpoint}` : ''}
        </Text>
        <Text
          accessibilityRole="header"
          className="font-heading text-[18px] leading-[24px] text-ink"
        >
          {title}
        </Text>
      </View>

      <Text
        accessibilityLiveRegion={isAlarming(note.status) ? 'polite' : 'none'}
        className="font-body text-[15px] leading-[22px] text-ink"
      >
        {sentenceFor(note.status, note.withdrawn, note.problem)}
      </Text>

      {note.description === '' ? null : (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
          {note.description}
        </Text>
      )}

      {/* The retired sentence offers copying and discarding, so it is said only where those are
          actually offered. A row this build cannot open has neither. */}
      {note.scope === 'retired' && note.status !== 'unusable' ? (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
          {RETIRED_SENTENCE}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {offers('open') && actions.open !== undefined ? (
          <Chip
            accessibilityHint="Opens this note in the editor"
            label="Open"
            onPress={() => {
              actions.open?.(note);
            }}
          />
        ) : null}

        {offers('record_again') && actions.recordAgain !== undefined ? (
          <Chip
            accessibilityHint="Writes your server’s answer to this phone again"
            label="Record it again"
            onPress={() => {
              actions.recordAgain?.(note);
            }}
          />
        ) : null}

        {offers('look_in') && actions.lookIn !== undefined && destination !== undefined ? (
          <Chip
            accessibilityHint="Opens where this was going, without creating anything"
            label={`Look in ${destination}`}
            onPress={() => {
              actions.lookIn?.(note);
            }}
          />
        ) : null}

        {offers('copy') && actions.copy !== undefined ? (
          <Chip
            accessibilityHint="Starts a separate note here carrying this writing"
            label="Copy into a new note"
            onPress={() => {
              actions.copy?.(note);
            }}
          />
        ) : null}

        {offers('dismiss') && actions.dismiss !== undefined ? (
          <Chip
            accessibilityHint="Removes this local note of a result your server already holds"
            label="Dismiss"
            onPress={() => {
              actions.dismiss?.(note);
            }}
          />
        ) : null}

        {offers('discard') && actions.discard !== undefined ? (
          <Chip
            accessibilityHint="Removes what is written here"
            label="Discard"
            onPress={() => {
              void confirmDiscard(discardPromptFor(note.status)).then((discard) => {
                if (discard) actions.discard?.(note);
              });
            }}
          />
        ) : null}
      </View>
    </Card>
  );
}
