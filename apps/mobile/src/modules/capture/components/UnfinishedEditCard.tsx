import { Text, View } from 'react-native';

import { Card, Chip, confirmDiscard } from '../../../ui';
import { displayTitle } from '../copy.ts';
import {
  editCardSentence,
  editKindWord,
  EDIT_DISCARD_PROMPT,
  isAlarmingEdit,
} from '../edit-composer.ts';
import type { UnfinishedEdit } from '../edit-unfinished.ts';
import { since } from '../when.ts';

export interface UnfinishedEditCardProps {
  edit: UnfinishedEdit;
  /** Sampled once per render by the screen, so a list of cards reads one clock. */
  now: number;
  onOpen?: ((edit: UnfinishedEdit) => void) | undefined;
  onDiscard?: ((edit: UnfinishedEdit) => void) | undefined;
  testID?: string | undefined;
}

/**
 * One entity whose changes are on this phone and not on the server.
 *
 * `UnfinishedCard` for edits, and the same shape on purpose: a person scanning the recovery screen
 * should not have to learn two card layouts for "here is something that has not landed". What differs
 * is the vocabulary, because the questions differ - a draft asks whether a creation happened, and an
 * edit asks how this phone's writing stands against what the server holds.
 *
 * **Nothing here decides anything.** The ordering, the scope and which actions are performable come
 * from `unfinishedEdits`; every sentence and every word comes from `edit-composer.ts`, so this card
 * and the editor cannot describe one record two ways. What is left is arrangement.
 *
 * **An unusable row is deliberately barer.** No title and no time, because both would be claims about
 * columns this build could not read - the projection hands over an empty title and a zero timestamp
 * rather than an invented one, and drawing "Untitled · 56 years ago" over it would be this card
 * inventing what the projection refused to.
 */
export function UnfinishedEditCard({
  edit,
  now,
  onOpen,
  onDiscard,
  testID,
}: UnfinishedEditCardProps) {
  const unusable = edit.standing === 'unusable';
  const alarming = isAlarmingEdit(edit.standing);
  const sentence = editCardSentence({
    standing: edit.standing,
    refusal: edit.refusal,
    problem: edit.problem,
    nodeType: edit.nodeType,
    kind: edit.kind,
  });

  return (
    <Card className="gap-3 p-4" testID={testID}>
      <View className="gap-1">
        <Text
          className={`font-body-medium text-[14px] ${alarming ? 'text-danger' : 'text-ink-soft'}`}
        >
          {editKindWord(edit.nodeType, edit.kind)}
          {/* A row this build cannot read has no time it can honestly claim to have been touched. */}
          {unusable ? '' : ` · ${since(edit.activityAt, now)}`}
          {edit.scope !== 'current' && edit.endpoint !== null && edit.endpoint !== ''
            ? ` · ${edit.endpoint}`
            : ''}
        </Text>
        {unusable ? null : (
          <Text
            accessibilityRole="header"
            className="font-heading text-[18px] leading-[24px] text-ink"
          >
            {displayTitle(edit.title)}
          </Text>
        )}
      </View>

      <Text
        accessibilityLiveRegion={alarming ? 'polite' : 'none'}
        className="font-body text-[15px] leading-[22px] text-ink"
      >
        {sentence}
      </Text>

      <View className="flex-row flex-wrap gap-2">
        {edit.actions.includes('open') && onOpen !== undefined ? (
          <Chip
            accessibilityHint="Opens this in the editor"
            label="Open"
            onPress={() => {
              onOpen(edit);
            }}
          />
        ) : null}

        {edit.actions.includes('discard') && onDiscard !== undefined ? (
          <Chip
            accessibilityHint="Removes the changes kept on this phone"
            label="Discard"
            onPress={() => {
              void confirmDiscard(EDIT_DISCARD_PROMPT).then((discard) => {
                if (discard) onDiscard(edit);
              });
            }}
          />
        ) : null}
      </View>
    </Card>
  );
}
