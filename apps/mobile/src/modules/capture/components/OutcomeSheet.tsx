import { Text, View } from 'react-native';

import { Chip, PrimaryButton, Sheet, SheetBody, SheetHeader } from '../../../ui';

/**
 * What the sheet is about.
 *
 * `refused` is only ever a refusal with **no earlier uncertainty**. A refusal that answers a replay
 * of a request that once went unanswered is `uncertain`, because the first dispatch may have
 * committed before its answer was lost, and saying "not saved" about it would be a claim this app
 * cannot support.
 */
export type OutcomeKind = 'refused' | 'uncertain';

export interface OutcomeSheetProps {
  visible: boolean;
  kind: OutcomeKind;
  /** The server's own sentence, or ours where the failure never reached one. */
  message: string;
  /**
   * A second sentence under the first, for an uncertainty that has since taken a refusal.
   *
   * It says what the latest try did without letting that become a claim about the first request,
   * which is the whole reason this stays the uncertain sheet rather than becoming the refusal one.
   */
  detail?: string | null | undefined;
  /** Named in the "Look in" chip. Absent when the hierarchy cannot name it right now. */
  destination: string | null;
  onClose: () => void;
  onRetry?: (() => void) | undefined;
  onLookIn?: (() => void) | undefined;
  /** Offered for the refusals whose remedy is somewhere else to put it. */
  onChooseDestination?: (() => void) | undefined;
  testID?: string | undefined;
}

const REFUSED_TITLE = 'Not saved';
const UNCERTAIN_TITLE = 'Raphael cannot tell whether this saved';
const UNCERTAIN_BODY =
  'The request left this phone and no answer came back, so your server may or may not have created it. Trying the same save again asks the same question under the same key, so it cannot make a second copy.';

/**
 * A failure or an uncertainty, as a decision that has to be made.
 *
 * A sheet rather than an inline line, because both of these need an answer: what is on screen is
 * writing that is safe on this phone and is not on the server, and closing the screen without
 * deciding is the one thing that should not be easy.
 *
 * Neither outcome ever loses anything. "Back to the note" is always available, and the writing is
 * exactly where it was.
 */
export function OutcomeSheet({
  visible,
  kind,
  message,
  detail,
  destination,
  onClose,
  onRetry,
  onLookIn,
  onChooseDestination,
  testID,
}: OutcomeSheetProps) {
  const uncertain = kind === 'uncertain';

  return (
    <Sheet
      className="gap-5 px-5 pb-6 pt-3"
      label={uncertain ? 'the unconfirmed save sheet' : 'the refusal sheet'}
      onClose={onClose}
      testID={testID}
      visible={visible}
    >
      <SheetHeader onClose={onClose} title={uncertain ? UNCERTAIN_TITLE : REFUSED_TITLE} />

      <SheetBody>
        <Text
          accessibilityLiveRegion="assertive"
          className="font-body text-[16px] leading-[24px] text-ink"
        >
          {uncertain ? UNCERTAIN_BODY : message}
        </Text>
        {uncertain && detail !== null && detail !== undefined && detail !== '' ? (
          <Text className="mt-3 font-body text-[15px] leading-[22px] text-ink-soft">{detail}</Text>
        ) : null}
      </SheetBody>

      {uncertain && onRetry !== undefined ? (
        <PrimaryButton
          accessibilityHint="Sends exactly the same request again"
          label="Try the same save again"
          onPress={onRetry}
        />
      ) : (
        <PrimaryButton
          accessibilityHint="Closes this and leaves the note as it is"
          label="Back to the note"
          onPress={onClose}
        />
      )}

      <View className="flex-row flex-wrap gap-2">
        {onLookIn !== undefined && destination !== null ? (
          <Chip
            accessibilityHint="Opens where this was going, without creating anything"
            label={`Look in ${destination}`}
            onPress={onLookIn}
          />
        ) : null}
        {onChooseDestination === undefined ? null : (
          <Chip
            accessibilityHint="Opens the list of areas and projects"
            label="Choose another place"
            onPress={onChooseDestination}
          />
        )}
        {uncertain ? (
          <Chip
            accessibilityHint="Closes this and leaves the note as it is"
            label="Keep editing"
            onPress={onClose}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
