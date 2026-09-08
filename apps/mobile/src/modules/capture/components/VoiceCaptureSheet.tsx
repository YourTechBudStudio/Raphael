import { X } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { Text, View } from 'react-native';

import {
  Card,
  confirmDiscard,
  IconButton,
  SavePill,
  Sheet,
  SheetBody,
  SheetHeader,
} from '../../../ui';
import { useSheetsStore } from '../../navigation';
import { usePlaybackStore, formatDuration, Waveform } from '../../playback';
import { useCreateVoiceNote } from '../client/mutations';
import { useCaptureLocation } from '../client/queries';
import { MAX_RECORDING_SECONDS, useMockRecorder } from '../state/useMockRecorder';
import { RecordingIndicator, ReviewPlayButton, StopButton, TextAction } from './controls';
import { liveBars, savedWaveform } from './waveform';

/** The take being reviewed is not a resource yet, so playback tracks it under its own id. */
const DRAFT_PLAYBACK_ID = 'voice-capture-draft';
const WAVEFORM_HEIGHT = 96;

/** Leaving throws the take away, so the sheet says so before it does. */
const DISCARD_PROMPT = {
  title: 'Discard this recording?',
  message: 'The take will not be saved.',
  keepLabel: 'Keep recording',
} as const;

/**
 * Voice capture: recording starts as soon as the sheet opens, stops into a review state where the
 * take can be played back, redone, or saved as a voice note in the current capture target.
 *
 * Nothing here is a real recording. The levels come from a mock generator, and the sheet is honest
 * about what it holds: it says where the note will be saved, it asks before throwing a take away,
 * and it says so when a save does not land.
 */
export function VoiceCaptureSheet() {
  const open = useSheetsStore((state) => state.open);
  const captureTarget = useSheetsStore((state) => state.captureTarget);
  const closeSheet = useSheetsStore((state) => state.close);

  const visible = open === 'voice-capture';

  const pathQuery = useCaptureLocation(captureTarget, visible);
  const path = pathQuery.data ?? [];
  const targetName = path.length === 0 ? undefined : path[path.length - 1]?.name;
  // Until the location is known the destination is unknown, not assumed: the same "…" the New
  // note sheet shows while it waits.
  const destination = targetName ?? '…';

  const recorder = useMockRecorder(visible);
  const createVoiceNote = useCreateVoiceNote();

  const playingId = usePlaybackStore((state) => state.playingId);
  const pausedId = usePlaybackStore((state) => state.pausedId);
  const elapsedSeconds = usePlaybackStore((state) => state.elapsedSeconds);
  const play = usePlaybackStore((state) => state.play);
  const pause = usePlaybackStore((state) => state.pause);
  const stopPlayback = usePlaybackStore((state) => state.stop);

  const recording = recorder.status === 'recording';
  const hasTake = recorder.samples.length > 0;
  const saving = createVoiceNote.isPending;
  const failed = createVoiceNote.isError;
  const durationSeconds = Math.max(1, Math.round(recorder.elapsedSeconds));
  // The saved shape is only needed once the take is finished, so recording does not pay for it.
  const captured = useMemo(
    () => (recording ? [] : savedWaveform(recorder.samples)),
    [recording, recorder.samples],
  );

  const playingDraft = playingId === DRAFT_PLAYBACK_ID;
  const draftActive = playingDraft || pausedId === DRAFT_PLAYBACK_ID;
  const progress = draftActive ? elapsedSeconds / durationSeconds : 0;

  // The draft only exists while this sheet is open, so its playback leaves with it.
  useEffect(() => {
    if (visible) {
      return;
    }

    const playback = usePlaybackStore.getState();

    if (playback.playingId === DRAFT_PLAYBACK_ID || playback.pausedId === DRAFT_PLAYBACK_ID) {
      stopPlayback();
    }
  }, [visible, stopPlayback]);

  const leave = () => {
    stopPlayback();
    createVoiceNote.reset();
    closeSheet();
  };

  // Leaving throws the take away, so it asks first once there is something to lose.
  const handleClose = () => {
    if (saving) {
      return;
    }

    if (!hasTake) {
      leave();

      return;
    }

    void confirmDiscard(DISCARD_PROMPT).then((discard) => {
      if (discard) {
        leave();
      }
    });
  };

  const handleStop = () => {
    recorder.stop();
  };

  const handleRecordAgain = () => {
    stopPlayback();
    createVoiceNote.reset();
    recorder.restart();
  };

  const handlePlayPress = () => {
    if (playingDraft) {
      pause();

      return;
    }

    play(DRAFT_PLAYBACK_ID, durationSeconds);
  };

  const handleSave = () => {
    if (!hasTake || saving) {
      return;
    }

    createVoiceNote.mutate(
      {
        target: captureTarget,
        title: `Voice note ${formatDuration(durationSeconds)}`,
        durationSeconds,
        waveform: captured,
      },
      { onSuccess: leave },
    );
  };

  const elapsedForDisplay = () => {
    if (recording) {
      return Math.floor(recorder.elapsedSeconds);
    }

    return draftActive ? elapsedSeconds : durationSeconds;
  };

  const timeLabel = formatDuration(elapsedForDisplay());
  const subtitle = recording ? `Recording to ${destination}` : `Saving to ${destination}`;

  const closeButton = (
    <IconButton
      accessibilityHint={
        hasTake ? 'Asks before discarding this recording.' : 'Closes voice capture.'
      }
      className="bg-primary-soft"
      icon={X}
      label="Close"
      onPress={handleClose}
    />
  );

  return (
    <Sheet
      className="gap-6 px-5"
      label="the voice note sheet"
      onClose={handleClose}
      testID="voice-capture-sheet"
      visible={visible}
    >
      <SheetHeader
        subtitle={subtitle}
        title="Voice note"
        {...(recording
          ? { trailing: closeButton }
          : {
              leading: closeButton,
              trailing: (
                <SavePill
                  accessibilityHint={
                    saving ? 'Saving this voice note' : `Saves this voice note to ${destination}`
                  }
                  disabled={!hasTake || saving}
                  label={saving ? 'Saving…' : 'Save'}
                  onPress={handleSave}
                  testID="voice-capture-save"
                />
              ),
            })}
      />

      {/* The take and its messages scroll; the controls below stay pinned and reachable. */}
      <SheetBody contentContainerStyle={{ gap: 24 }}>
        <Card className="items-center gap-4 px-5 py-6" variant="lilac" wave waveHeight={72}>
          {recording ? <RecordingIndicator /> : null}
          <Waveform
            barWidth={3}
            className="w-full"
            height={WAVEFORM_HEIGHT}
            progress={progress}
            values={recording ? liveBars(recorder.samples) : captured}
          />
          <Text
            accessibilityLabel={`${recording ? 'Recorded so far' : 'Length'} ${timeLabel}`}
            className="font-heading text-[40px] leading-[48px] text-ink"
          >
            {timeLabel}
          </Text>
        </Card>

        {recorder.atLimit ? (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            {`That is the longest note this mock records (${formatDuration(MAX_RECORDING_SECONDS)}). Save it or record again.`}
          </Text>
        ) : null}

        {!recording && !hasTake ? (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            There is nothing in this take yet. Record again and say something.
          </Text>
        ) : null}

        {failed ? (
          <Text className="font-body text-[15px] leading-[22px] text-danger">
            That voice note did not save. The recording is still here — try Save again.
          </Text>
        ) : null}
      </SheetBody>

      {recording ? (
        <View className="items-center gap-2 pb-2">
          <StopButton onPress={handleStop} />
          <TextAction
            accessibilityHint="Asks before discarding this recording."
            label="Cancel"
            onPress={handleClose}
          />
        </View>
      ) : (
        <View className="items-center gap-2 pb-2">
          {hasTake ? <ReviewPlayButton onPress={handlePlayPress} playing={playingDraft} /> : null}
          <TextAction
            accessibilityHint="Throws this take away and starts a new recording."
            label="Record again"
            onPress={handleRecordAgain}
          />
        </View>
      )}
    </Sheet>
  );
}
