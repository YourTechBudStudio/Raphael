import { Text, View } from 'react-native';

import { Card, Chip, confirmDiscard } from '../../../ui';
import { createdBy, type AttemptView } from './derive.ts';
import { describeUnresolved, DISCARD_REFUSED_PROMPT, DISCARD_UNRESOLVED_PROMPT } from './draft.ts';
import type { AttemptRecord } from './types.ts';

/**
 * What a host can offer for one attempt. All optional, because a host without a connection has
 * none of them and must still be able to render the record.
 */
export interface AttemptActions {
  readonly retry?: ((attemptId: string) => void) | undefined;
  readonly openDestination?: ((record: AttemptRecord) => void) | undefined;
  readonly openCreated?: ((record: AttemptRecord) => void) | undefined;
  /** Opens a new, separate creation carrying this attempt's input. */
  readonly recoverInput?: ((record: AttemptRecord) => void) | undefined;
  readonly discard?: ((attemptId: string) => void) | undefined;
  /** Only for a success whose local acknowledgement could not be written. */
  readonly saveResult?: ((attemptId: string) => void) | undefined;
}

export interface AttemptCardProps {
  view: AttemptView;
  actions: AttemptActions;
  /** A known creation whose local record could not be written. */
  unsavedResult?: { readonly title: string } | undefined;
  /** Shown when the attempt belongs to a connection that is not the active one. */
  showEndpoint?: boolean | undefined;
}

const NOUN = { area: 'Area', project: 'Project' } as const;

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * One unfinished creation, said plainly.
 *
 * The three classes of record here are deliberately not one "pending" row with a different colour.
 * A creation that definitely happened and is waiting to be looked at, a refusal holding input
 * someone can correct, and an attempt whose outcome nobody knows are three different situations
 * with three different next actions, and flattening them would make the one that needs attention
 * look like the two that do not.
 */
export function AttemptCard({
  view,
  actions,
  unsavedResult,
  showEndpoint = false,
}: AttemptCardProps) {
  const { record, logical } = view;
  const noun = NOUN[record.type];
  const created = createdBy(view);

  const heading =
    logical === 'created'
      ? `${noun} created`
      : logical === 'refused'
        ? `${noun} not created`
        : `${noun} may not have been created`;

  const explanation =
    logical === 'created'
      ? unsavedResult === undefined
        ? 'Raphael has this from the server. Open it, or dismiss this note.'
        : 'The server created this. Raphael could not write that down on this phone, so the note is being kept in memory until it can.'
      : logical === 'refused'
        ? (record.lastOutcome?.message ??
          'The server refused this. The title is kept so it can be changed.')
        : describeUnresolved(record.title);

  return (
    <Card className="gap-3" variant="warm">
      <View className="gap-1">
        <Text
          accessibilityRole="header"
          className="font-heading text-[18px] leading-[24px] text-ink"
        >
          {record.title}
        </Text>
        <Text className="font-body text-[13px] leading-[18px] text-ink-soft">
          {heading} · {when(record.firstDispatchAt)}
          {showEndpoint ? ` · ${record.endpoint}` : ''}
        </Text>
      </View>

      <Text
        accessibilityLiveRegion={logical === 'unresolved' ? 'polite' : 'none'}
        className="font-body text-[15px] leading-[22px] text-ink"
      >
        {explanation}
      </Text>

      {/* The window sentence is only worth saying while the outcome is still open. */}
      {view.note === null ? null : (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">{view.note}</Text>
      )}

      {!view.connected && showEndpoint ? (
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
          This was sent to another server. Connect to it to send it again or open where it was
          going.
        </Text>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {logical === 'created' && unsavedResult === undefined && view.connected && created ? (
          <Chip
            accessibilityHint="Opens what the server created"
            label={`Open ${created.title}`}
            onPress={() => actions.openCreated?.(record)}
          />
        ) : null}

        {logical === 'created' && unsavedResult !== undefined ? (
          <Chip
            accessibilityHint="Writes the result to this phone again"
            label="Save this result again"
            onPress={() => actions.saveResult?.(record.attemptId)}
          />
        ) : null}

        {view.canRetry && actions.retry !== undefined ? (
          <Chip
            accessibilityHint="Sends exactly the same request again"
            disabled={view.sending}
            label={view.sending ? 'Sending…' : 'Try again'}
            onPress={() => actions.retry?.(record.attemptId)}
          />
        ) : null}

        {logical === 'unresolved' && view.canOpenDestination && actions.openDestination ? (
          <Chip
            accessibilityHint="Opens where this was going, without creating anything"
            label="View destination"
            onPress={() => actions.openDestination?.(record)}
          />
        ) : null}

        {actions.recoverInput !== undefined && logical !== 'created' ? (
          <Chip
            accessibilityHint={
              logical === 'refused'
                ? 'Opens this title for correction'
                : 'Starts a separate creation with this title'
            }
            label={logical === 'refused' ? 'Change the title' : 'Create it separately'}
            onPress={() => actions.recoverInput?.(record)}
          />
        ) : null}

        {actions.discard !== undefined ? (
          <Chip
            accessibilityHint={
              logical === 'created'
                ? 'Removes this note from the phone'
                : 'Removes Raphael’s record of this attempt'
            }
            label={logical === 'created' ? 'Dismiss' : 'Discard'}
            onPress={() => {
              // A dismissal removes a local note about something that definitely exists, so there
              // is nothing to warn about. Discarding an unresolved attempt throws away the only
              // record that a creation may have happened, which is not the same act at all.
              if (logical === 'created') {
                actions.discard?.(record.attemptId);

                return;
              }

              // The ambiguity warning is reserved for actual ambiguity. Telling someone that
              // discarding a refusal "cannot undo a creation the server may already have made"
              // contradicts the refusal they are looking at, and a warning that is sometimes false
              // is one nobody reads the next time it is true.
              const prompt =
                logical === 'refused' ? DISCARD_REFUSED_PROMPT : DISCARD_UNRESOLVED_PROMPT;

              void confirmDiscard(prompt).then((discard) => {
                if (discard) actions.discard?.(record.attemptId);
              });
            }}
          />
        ) : null}
      </View>
    </Card>
  );
}
