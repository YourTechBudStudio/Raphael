import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { gutter, PrimaryButton, StateLine, TextAction, WaitingLine } from '../../../ui';
import { ConnectionArt } from './ConnectionArt';

export interface OfflineScreenProps {
  /** The server this phone is trying to reach, as its address. */
  origin: string;
  /** A check is in flight: the thread carries a dot and the button waits. */
  checking: boolean;
  /** Whole seconds until the next automatic check. */
  secondsUntilCheck: number;
  onTryNow: () => void;
  onChangeServer: () => void;
}

/**
 * The one screen shown when the server cannot be reached.
 *
 * It checks again on its own, so the button skips the wait rather than being the only way back, and
 * the countdown says so. Change sits beside the address because an address that moved is the likely
 * reason someone is here.
 *
 * The words scroll and the actions stay put, so large text never pushes Try now off the screen.
 */
export function OfflineScreen({
  origin,
  checking,
  secondsUntilCheck,
  onTryNow,
  onChangeServer,
}: OfflineScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-canvas" style={{ paddingBottom: insets.bottom + 20 }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          gap: 32,
          paddingHorizontal: gutter,
          paddingTop: insets.top + 56,
          paddingBottom: 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <ConnectionArt mode="broken" travelling={checking} />
        <View className="gap-3">
          <View className="gap-2">
            <Text
              accessibilityRole="header"
              className="text-center font-heading text-[28px] leading-[34px] text-ink"
            >
              Can’t reach your server.
            </Text>
            <Text className="text-center font-body text-[16px] leading-[24px] text-ink-soft">
              Raphael needs it to show your notes. Anything you were writing stays on this phone
              until it’s back.
            </Text>
          </View>
          <View className="flex-row items-center justify-center">
            <Text className="shrink font-body-medium text-[16px] text-ink" numberOfLines={1}>
              {origin}
            </Text>
            <Text className="pl-2 font-body text-[16px] text-ink-soft">·</Text>
            <TextAction
              accessibilityHint="Points this phone at a different server"
              label="Change"
              onPress={onChangeServer}
            />
          </View>
        </View>
      </ScrollView>

      <View className="gap-3" style={{ paddingHorizontal: gutter }}>
        <View className="items-center">
          {checking ? (
            <WaitingLine>Checking…</WaitingLine>
          ) : (
            <StateLine>{`Checking again in ${String(secondsUntilCheck)} s`}</StateLine>
          )}
        </View>
        <PrimaryButton
          accessibilityHint="Checks your server now instead of waiting"
          busy={checking}
          label={checking ? 'Checking…' : 'Try now'}
          onPress={onTryNow}
        />
      </View>
    </View>
  );
}
