import { Pause, Play } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { VoiceResource } from '../../../infrastructure/api/contracts';
import { Card, CircleButton } from '../../../ui';
import { usePlaybackStore, formatDuration, Waveform } from '../../playback';
import { CardSummary, CardTitle } from './card-text';
import { KindLabel } from './KindLabel';
import type { ResourceCardLayout } from './layout';

/** Play and pause live inside the card's press surface, so they are offered here as an action. */
const PLAYBACK_ACTION = 'playback';

export interface VoiceCardProps {
  resource: VoiceResource;
  /** `full` spreads the player beside the text; `column` stacks it underneath. */
  layout?: ResourceCardLayout | undefined;
  onPress?: (() => void) | undefined;
  waveSeed?: number | undefined;
  testID?: string | undefined;
}

/**
 * A voice note. The bars stand still until this note is the one playing, at which point
 * the played portion fills in step with the elapsed counter in the playback store.
 */
export function VoiceCard({
  resource,
  layout = 'full',
  onPress,
  waveSeed = 0,
  testID,
}: VoiceCardProps) {
  const playingId = usePlaybackStore((state) => state.playingId);
  const pausedId = usePlaybackStore((state) => state.pausedId);
  const elapsedSeconds = usePlaybackStore((state) => state.elapsedSeconds);
  const play = usePlaybackStore((state) => state.play);
  const pause = usePlaybackStore((state) => state.pause);

  const playing = playingId === resource.id;
  const active = playing || pausedId === resource.id;
  const progress =
    active && resource.durationSeconds > 0 ? elapsedSeconds / resource.durationSeconds : 0;

  const handlePlayPress = () => {
    if (playing) {
      pause();

      return;
    }

    play(resource.id, resource.durationSeconds);
  };

  // While a note plays, the label counts up; at rest it reads the full length.
  const timeLabel = formatDuration(active ? elapsedSeconds : resource.durationSeconds);
  const isFull = layout === 'full';

  return (
    <Card
      // A screen reader merges the play button into the pressable card, so playback is offered
      // as an action on the card itself and the card says whether this note is playing.
      accessibilityActions={
        onPress === undefined
          ? undefined
          : [{ name: PLAYBACK_ACTION, label: playing ? 'Pause' : 'Play' }]
      }
      accessibilityLabel={`Voice note. ${resource.title}. ${resource.summary}`}
      accessibilityValue={active ? { text: playing ? 'Playing' : 'Paused' } : undefined}
      onAccessibilityAction={
        onPress === undefined
          ? undefined
          : (event) => {
              if (event.nativeEvent.actionName === PLAYBACK_ACTION) {
                handlePlayPress();
              }
            }
      }
      onPress={onPress}
      testID={testID}
      wave
      waveHeight={isFull ? 76 : 64}
      waveSeed={waveSeed}
    >
      <View className="p-4">
        <KindLabel kind="voice" size={34} />

        {isFull ? (
          <View className="mt-3 flex-row items-center gap-3">
            <View className="flex-1">
              <CardTitle>{resource.title}</CardTitle>
              <CardSummary className="mt-1">{resource.summary}</CardSummary>
            </View>
            <CircleButton
              icon={playing ? Pause : Play}
              label={playing ? `Pause ${resource.title}` : `Play ${resource.title}`}
              onPress={handlePlayPress}
              size={52}
            />
            <Waveform className="w-24" height={40} progress={progress} values={resource.waveform} />
          </View>
        ) : (
          <View className="mt-3">
            <CardTitle>{resource.title}</CardTitle>
            <CardSummary className="mt-1">{resource.summary}</CardSummary>
            <View className="mt-4 flex-row items-center gap-3">
              <CircleButton
                icon={playing ? Pause : Play}
                label={playing ? `Pause ${resource.title}` : `Play ${resource.title}`}
                onPress={handlePlayPress}
                size={44}
              />
              <Waveform
                className="flex-1"
                height={36}
                progress={progress}
                values={resource.waveform}
              />
            </View>
          </View>
        )}

        <Text className="mt-3 self-end font-body text-[14px] text-ink">{timeLabel}</Text>
      </View>
    </Card>
  );
}
