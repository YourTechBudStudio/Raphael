import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { EmptyState, Screen, SectionError, SectionHeading } from '../../../ui';
import { goBack, openBrowse, openCapture, openContainer, TitleTopBar } from '../../navigation';
import { useDestinationName } from '../client/destinations.ts';
import { useUnfinishedActions, useUnfinishedNotes } from '../client/notes.ts';
import { useCaptureOwner } from '../client/owner.ts';
import { COPY_NOTICE, RETIRED_HEADING, UNKNOWN_HEADING, UNKNOWN_SENTENCE } from '../copy.ts';
import type { UnfinishedNote } from '../unfinished.ts';
import { UnfinishedCard } from './UnfinishedCard';

/**
 * Everything unfinished, notes only.
 *
 * Containers are not drafts any more: creating an area or a project is one request from its own
 * sheet, and nothing about it is written to this phone. So there is no "Areas and projects" section
 * here, and there is nothing left to restore - the removal is the architecture, not a gap.
 *
 * This screen exists behind the connection gate, and only there. Without a connection the app opens
 * setup and nothing else, so there is no route to this and no reading, copying or discarding
 * underneath it. Work that belongs to a server this phone has left is still here afterwards, under
 * its own heading, offering only the two things that need no server: copy it into a new note here,
 * or discard it.
 *
 * The four states are kept apart deliberately. "Raphael has not finished looking", "there is nothing
 * unfinished", "here is what is unfinished", and "Raphael cannot read its record of unfinished work"
 * are four different sentences, and the last one must never be shown as the second.
 */
export function RecoveryScreen() {
  const status = useCaptureOwner((state) => state.status);
  const problem = useCaptureOwner((state) => state.problem);
  const retryOpen = useCaptureOwner((state) => state.retryOpen);
  const unreadable = useCaptureOwner((state) => state.unreadableAttempts);
  const notes = useUnfinishedNotes();
  const nameOf = useDestinationName();
  const actions = useUnfinishedActions();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Sampled once per render rather than ticked: a 71-hour window does not need a timer.
  const [now] = useState(() => Date.now());

  const here = useMemo(() => notes.filter((note) => note.scope === 'current'), [notes]);
  const elsewhere = useMemo(() => notes.filter((note) => note.scope === 'retired'), [notes]);
  // Under neither heading: saying where these came from is precisely what could not be read.
  const unplaced = useMemo(() => notes.filter((note) => note.scope === 'unknown'), [notes]);

  const cardActions = {
    open: (note: UnfinishedNote) => {
      if (note.draftId !== null) openCapture(note.draftId);
    },
    lookIn: (note: UnfinishedNote) => {
      // The root is not a container, so a note aimed at one that cannot be named opens Browse
      // rather than pretending there is a screen for it.
      if (note.destination === null) openBrowse();
      else openContainer(note.destination);
    },
    copy: (note: UnfinishedNote) => {
      const draftId = note.draftId;

      if (draftId === null) return;

      void (async () => {
        setNotice(null);
        setFailure(null);

        const result = await actions.copy(draftId);

        if (result.kind === 'refused') setFailure(result.problem);
        else setNotice(COPY_NOTICE);
      })();
    },
    recordAgain: (note: UnfinishedNote) => {
      const attemptId = note.attemptId;

      if (attemptId === null) return;

      void (async () => {
        setFailure(null);

        const result = await actions.recordAgain(attemptId);

        if (result.kind === 'refused') setFailure(result.problem);
      })();
    },
    discard: (note: UnfinishedNote) => {
      const draftId = note.draftId;

      if (draftId === null) return;

      void (async () => {
        setFailure(null);

        const result = await actions.discard(draftId);

        if (result.kind === 'refused') setFailure(result.problem);
      })();
    },
    dismiss: (note: UnfinishedNote) => {
      if (note.attemptId !== null) void actions.dismiss(note.attemptId);
    },
  };

  const render = (note: UnfinishedNote) => {
    const named = nameOf(note.destination).leaf;

    return (
      <UnfinishedCard
        actions={cardActions}
        {...(named === null ? {} : { destination: named })}
        key={note.key}
        note={note}
        now={now}
      />
    );
  };

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Unfinished" />}>
      <View className="gap-5">
        <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
          Notes Raphael has not been able to finish, and results it has not shown you yet. Nothing
          here is removed on its own.
        </Text>

        {notice === null ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="font-body text-[15px] leading-[22px] text-ink"
          >
            {notice}
          </Text>
        )}

        {failure === null ? null : (
          <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
            {failure}
          </Text>
        )}

        {status === 'unavailable' ? (
          <SectionError
            description={
              problem?.kind === 'unsupported_version'
                ? 'These notes were written by a newer version of Raphael. Nothing has been changed or removed; update the app to read them.'
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
        ) : notes.length === 0 && unreadable === 0 ? (
          // Said only when it is true of everything, including the rows this build cannot open and
          // the records it could not read. "Nothing unfinished" above a line counting notes that
          // cannot be opened would be the screen contradicting itself.
          <EmptyState
            description="Everything you have written is either on your server or has a definite answer."
            title="Nothing unfinished."
          />
        ) : null}

        {here.map(render)}

        {elsewhere.length === 0 ? null : (
          <View className="gap-3">
            <SectionHeading>{RETIRED_HEADING}</SectionHeading>
            {elsewhere.map(render)}
          </View>
        )}

        {unplaced.length === 0 ? null : (
          <View className="gap-3">
            <SectionHeading>{UNKNOWN_HEADING}</SectionHeading>
            <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
              {UNKNOWN_SENTENCE}
            </Text>
            {unplaced.map(render)}
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
    </Screen>
  );
}
