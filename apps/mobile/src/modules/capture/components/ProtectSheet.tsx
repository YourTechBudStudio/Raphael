import { Text, View } from 'react-native';

import { Chip, PrimaryButton, Sheet, SheetBody, SheetHeader } from '../../../ui';
import type { ProtectionProblem } from '../composer.ts';

export interface ProtectSheetProps {
  visible: boolean;
  problem: ProtectionProblem;
  /** False once undo is exhausted: the offer disappears rather than promising a repair it cannot do. */
  canUndo: boolean;
  /**
   * True when a save for this note was sent and never answered.
   *
   * Discarding then removes the writing and **keeps** the record of the question that was asked,
   * because discarding writing cannot un-ask it. The sheet has to say so: someone giving up on a
   * note must not be left believing they have also cancelled a creation the server may have made.
   */
  hasUnresolvedEvidence?: boolean | undefined;
  /** Repairs the latest unprotected change. Never deletes the note. */
  onRepair: () => void;
  onKeepEditing: () => void;
  /** Deletes the draft and everything written in it. */
  onDiscard: () => void;
  testID?: string | undefined;
}

const REPAIR_KEEPS_THE_NOTE = 'Repairing acts on the last change only; the note stays.';
const DISCARD_REMOVES_THE_NOTE = 'Discarding deletes the note and everything written in it.';
const DISCARD_KEEPS_EVIDENCE =
  'Discarding deletes the note and everything written in it. Raphael keeps its record of the save it could not confirm, because throwing writing away cannot undo a note your server may already hold.';

const COPY: Record<ProtectionProblem, { readonly title: string; readonly body: string }> = {
  failed_write: {
    title: 'This change is not on this phone',
    body: 'Raphael could not write your last change to this phone. What is on screen is real and is not saved anywhere; the change before it is.',
  },
  too_large: {
    title: 'This note is too large to keep here',
    body: 'The editor could not hand this note over, so Raphael has no copy of what is on screen. Undoing the last change or cutting the note down is what makes it storable again.',
  },
  unanswered: {
    title: 'Raphael could not take a copy',
    body: 'The editor did not answer, so Raphael does not know what you have written since the last change it saved. What is on screen is still in the editor.',
  },
};

/**
 * Leaving is not allowed while the only copy of something is on screen.
 *
 * The sheet forces a choice, and every choice keeps the person in control of their own writing: try
 * the repair, stay and change it, or say explicitly that it can go. The renderer stays alive
 * underneath all three, because unmounting it is what would destroy the copy this sheet exists
 * about.
 *
 * Undo is offered only while there is one. An exhausted undo that still appeared would be a promise
 * of a repair that cannot happen, and the honest remainder - keep editing, or discard - is what is
 * left.
 *
 * The two ends of that choice are deliberately not neighbours in meaning, and the words say so.
 * Repairing or undoing acts on **the latest change**: the note stays, and so does everything in it.
 * The destructive action deletes **the note**, which is why it is never labelled "discard changes"
 * and why it states what goes and what is kept. The sheet is itself the forced decision, so there is
 * no second confirmation over it - which puts the whole weight on this wording.
 */
export function ProtectSheet({
  visible,
  problem,
  canUndo,
  hasUnresolvedEvidence = false,
  onRepair,
  onKeepEditing,
  onDiscard,
  testID,
}: ProtectSheetProps) {
  const copy = COPY[problem];
  // Trying again is the remedy for both a failed write and a silent editor. Only an oversized
  // document needs undo, and only while there is one to undo.
  const repairable = problem !== 'too_large' || canUndo;

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      label="the unprotected writing sheet"
      onClose={onKeepEditing}
      testID={testID}
      visible={visible}
    >
      <SheetHeader onClose={onKeepEditing} title={copy.title} />

      <SheetBody>
        <Text
          accessibilityLiveRegion="assertive"
          className="font-body text-[16px] leading-[24px] text-ink"
        >
          {copy.body}
        </Text>
        <Text className="mt-3 font-body text-[15px] leading-[22px] text-ink-soft">
          {repairable ? REPAIR_KEEPS_THE_NOTE : ''}
          {repairable ? ' ' : ''}
          {hasUnresolvedEvidence ? DISCARD_KEEPS_EVIDENCE : DISCARD_REMOVES_THE_NOTE}
        </Text>
      </SheetBody>

      {repairable ? (
        <PrimaryButton
          accessibilityHint={
            problem === 'too_large'
              ? 'Undoes the last change in the editor'
              : 'Tries to take a copy of this note again'
          }
          label={problem === 'too_large' ? 'Undo the last change' : 'Try writing it again'}
          onPress={onRepair}
        />
      ) : (
        <PrimaryButton
          accessibilityHint="Closes this and leaves the note open"
          label="Keep editing"
          onPress={onKeepEditing}
        />
      )}

      <View className="flex-row flex-wrap gap-2">
        {repairable ? (
          <Chip
            accessibilityHint="Closes this and leaves the note open"
            label="Keep editing"
            onPress={onKeepEditing}
          />
        ) : null}
        <Chip
          accessibilityHint={
            hasUnresolvedEvidence
              ? 'Deletes this note and everything written in it. Raphael keeps its record of the save it could not confirm'
              : 'Deletes this note and everything written in it'
          }
          label="Discard this note"
          onPress={onDiscard}
        />
      </View>
    </Sheet>
  );
}
