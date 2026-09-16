import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Card, type CardVariant } from '../../../ui';
import { CardSummary, CardTitle } from './card-text';

export interface NoteCardShellProps {
  /** The line above the title: a location, or a status. Whoever draws it decides. */
  eyebrow: ReactNode;
  title: string;
  /** The line under the title. Omitted entirely when empty; an empty line is not a line. */
  description?: string | undefined;
  /** Spoken as one sentence, because a card is one control rather than four pieces of text. */
  accessibilityLabel: string;
  /** A draft's dotted edge. Plain otherwise. */
  className?: string | undefined;
  variant?: CardVariant | undefined;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
}

/**
 * The shape of a note card: an eyebrow, a title, and a description when there is one.
 *
 * It exists as its own piece because two different cards have to look identical and are produced by
 * different capabilities. This one draws a note the server holds; Phase 06 draws a note that is only
 * on this phone, from capture's records, with a status where the location goes. They are the same
 * card to look at and must stay that way, and the way to guarantee that is for there to be one of
 * them rather than two that are currently in agreement.
 *
 * It is presentation and nothing else: no query, no navigation, no knowledge of what a note is.
 */
export function NoteCardShell({
  eyebrow,
  title,
  description,
  accessibilityLabel,
  className,
  variant = 'lilac',
  onPress,
  testID,
}: NoteCardShellProps) {
  return (
    <Card
      accessibilityLabel={accessibilityLabel}
      className={className}
      onPress={onPress}
      testID={testID}
      variant={variant}
    >
      <View className="p-4">
        {eyebrow}
        <CardTitle className="mt-3">{title}</CardTitle>
        {description === undefined || description === '' ? null : (
          <CardSummary className="mt-1">{description}</CardSummary>
        )}
      </View>
    </Card>
  );
}
