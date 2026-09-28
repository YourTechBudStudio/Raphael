import { GitCompareArrows } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { colors, confirmDiscard, PressableFeedback } from '../../../ui';
import { CONFLICT_BAND, KEEP_MINE_PROMPT, TAKE_SERVERS_PROMPT } from '../sync-copy.ts';

export interface ConflictBandProps {
  /** Called once the person has confirmed dropping their version. */
  onTakeServers: () => void;
  /** Called once the person has confirmed sending theirs over the server's. */
  onKeepMine: () => void;
}

/**
 * The editor's answer to "this changed on your server while you were editing": one sentence and two
 * ways out, both confirmed, above the bar. Not the error colour - nothing failed, two versions exist.
 *
 * Not mounted yet: phase 03 of the online-only plan puts it in `EditView` over an `unsent` row.
 */
export function ConflictBand({ onTakeServers, onKeepMine }: ConflictBandProps) {
  return (
    <View accessibilityLiveRegion="polite" className="gap-1 border-b border-line py-2 pl-4 pr-2">
      <View className="flex-row items-center gap-3">
        <GitCompareArrows color={colors.primary} size={20} strokeWidth={2} />
        <Text className="flex-1 font-body text-[15px] leading-[20px] text-ink">
          {CONFLICT_BAND}
        </Text>
      </View>
      <View className="flex-row justify-end gap-1">
        <PressableFeedback
          accessibilityHint="Asks before replacing your changes with your server’s version"
          accessibilityLabel="Take server’s"
          className="h-11 justify-center rounded-full px-3"
          onPress={() => {
            void confirmDiscard(TAKE_SERVERS_PROMPT).then((confirmed) => {
              if (confirmed) onTakeServers();
            });
          }}
          stateLayerColor={colors.primary}
          treatment="button"
        >
          <Text className="font-body-semibold text-[15px] text-primary">Take server’s</Text>
        </PressableFeedback>
        <PressableFeedback
          accessibilityHint="Asks before sending your version over your server’s"
          accessibilityLabel="Keep mine"
          className="h-11 justify-center rounded-full bg-primary px-4"
          onPress={() => {
            void confirmDiscard(KEEP_MINE_PROMPT).then((confirmed) => {
              if (confirmed) onKeepMine();
            });
          }}
          stateLayerColor={colors.onPrimary}
          treatment="button"
        >
          <Text className="font-body-semibold text-[15px] text-on-primary">Keep mine</Text>
        </PressableFeedback>
      </View>
    </View>
  );
}
