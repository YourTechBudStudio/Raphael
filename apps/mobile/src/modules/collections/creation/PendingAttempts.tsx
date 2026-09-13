import { Text, View } from 'react-native';

import {
  EmptyState,
  SectionError,
  SectionHeading,
  SkeletonBlock,
  SkeletonGroup,
} from '../../../ui';
import { useAttemptActions, useAttemptGroups, useCreationOwner } from '../client/creation';
import { AttemptCard, type AttemptActions } from './AttemptCard.tsx';

export interface PendingAttemptsProps {
  /**
   * What this host can do. A host with no connection passes navigation actions as undefined and
   * the rows render without them - reading a record, recovering its input, and discarding it need
   * no server at all.
   */
  actions?: Omit<AttemptActions, 'retry' | 'discard' | 'saveResult'> | undefined;
  /** Hides the heading where the host already has one. */
  heading?: string | null | undefined;
  /** Renders nothing at all when there is nothing unfinished, for hosts that are not about this. */
  hideWhenEmpty?: boolean | undefined;
}

/**
 * Everything unfinished on this phone, whichever server it belongs to.
 *
 * This component has no unconditional dependency on the router or on a connection, and that is what
 * makes it usable from the setup screen - which is where someone lands after a disconnect, and where
 * "available without a connection" either holds or does not. Hosts hand in what they can do.
 *
 * The four states are kept apart deliberately. "Raphael has not finished looking", "there is nothing
 * unfinished", "here is what is unfinished", and "Raphael cannot read its record of unfinished work"
 * are four different sentences, and the last one must never be shown as the second.
 */
export function PendingAttempts({
  actions,
  heading = 'Unfinished',
  hideWhenEmpty = false,
}: PendingAttemptsProps) {
  const status = useCreationOwner((state) => state.status);
  const problem = useCreationOwner((state) => state.problem);
  const unreadable = useCreationOwner((state) => state.unreadable);
  const unsaved = useCreationOwner((state) => state.unsaved);
  const retryOpen = useCreationOwner((state) => state.retryOpen);
  const { here, elsewhere } = useAttemptGroups();
  const { retry, discard, saveAcknowledgement } = useAttemptActions();

  const rowActions: AttemptActions = {
    ...actions,
    retry: (attemptId) => {
      void retry(attemptId);
    },
    discard: (attemptId) => {
      void discard(attemptId);
    },
    saveResult: (attemptId) => {
      void saveAcknowledgement(attemptId);
    },
  };

  if (status === 'unavailable') {
    return (
      <View className="gap-3">
        {heading === null ? null : <SectionHeading>{heading}</SectionHeading>}
        <SectionError
          description={
            problem?.kind === 'unsupported_version'
              ? 'These records were written by a newer version of Raphael. Nothing has been changed or removed; update the app to read them.'
              : 'Raphael could not open its record of unfinished work on this phone. Nothing has been removed.'
          }
          // A newer schema is not something a second attempt can fix, so no retry is offered
          // against it. An open that failed for another reason may well succeed.
          onRetry={
            problem?.kind === 'unsupported_version'
              ? undefined
              : () => {
                  void retryOpen();
                }
          }
          title="Unfinished work could not be read."
        />
      </View>
    );
  }

  if (status !== 'ready') {
    return hideWhenEmpty ? null : (
      <View className="gap-3">
        {heading === null ? null : <SectionHeading>{heading}</SectionHeading>}
        <SkeletonGroup label="Loading unfinished creations">
          <SkeletonBlock height={96} />
        </SkeletonGroup>
      </View>
    );
  }

  if (here.length === 0 && elsewhere.length === 0) {
    return hideWhenEmpty ? null : (
      <View className="gap-3">
        {heading === null ? null : <SectionHeading>{heading}</SectionHeading>}
        <EmptyState
          description="Everything you have created has a definite answer."
          title="Nothing unfinished."
        />
      </View>
    );
  }

  return (
    <View className="gap-3">
      {heading === null ? null : <SectionHeading>{heading}</SectionHeading>}

      {here.map((view) => (
        <AttemptCard
          actions={rowActions}
          key={view.record.attemptId}
          unsavedResult={unsaved[view.record.attemptId]}
          view={view}
        />
      ))}

      {elsewhere.length === 0 ? null : (
        <View className="gap-3">
          <SectionHeading>From another server</SectionHeading>
          {elsewhere.map((view) => (
            <AttemptCard
              actions={rowActions}
              key={view.record.attemptId}
              showEndpoint
              unsavedResult={unsaved[view.record.attemptId]}
              view={view}
            />
          ))}
        </View>
      )}

      {unreadable === 0 ? null : (
        <Text className="font-body text-[13px] leading-[18px] text-ink-soft">
          {unreadable === 1
            ? 'One saved record could not be read. It has been left on this phone rather than removed.'
            : `${String(unreadable)} saved records could not be read. They have been left on this phone rather than removed.`}
        </Text>
      )}
    </View>
  );
}
