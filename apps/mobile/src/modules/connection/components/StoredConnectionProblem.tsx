import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Chip } from '../../../ui';
import { gutter } from '../../../ui/theme';
import { useConnectionStore } from '../state/connection';

export interface StoredConnectionProblemProps {
  message: string;
  /**
   * Shown below the explanation. A keychain that cannot be read says nothing about records this app
   * keeps for itself, so anything unfinished stays reachable from here.
   */
  footer?: ReactNode | undefined;
}

/**
 * There is something in the keychain, and it cannot be used.
 *
 * Its own screen, rather than being folded into first-run setup, because the two say opposite
 * things. Setup says "this device has never had a server"; this says "this device has one written
 * down and something is wrong with it". Sending someone through the first when the second is true
 * makes a stored connection look as though it had silently evaporated, and hides the one fact that
 * would explain it.
 *
 * The way out deletes the stored record, so it says that plainly rather than calling itself
 * "start again". Nothing on the server is touched, and the address and key can be entered again.
 */
export function StoredConnectionProblem({ message, footer }: StoredConnectionProblemProps) {
  const disconnect = useConnectionStore((state) => state.disconnect);

  return (
    <ScrollView
      className="flex-1 bg-canvas"
      contentContainerStyle={{ padding: gutter, flexGrow: 1, justifyContent: 'center' }}
    >
      <View className="max-w-[420px] gap-3 self-center">
        <Text
          accessibilityRole="header"
          className="font-heading text-[28px] leading-[34px] text-ink"
        >
          The saved connection cannot be read.
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-[16px] leading-[23px] text-ink-soft"
        >
          {message}
        </Text>
        <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
          Nothing on your server is affected. Clearing what is saved here lets you enter the address
          and key again.
        </Text>
        <View className="flex-row pt-1">
          <Chip
            accessibilityHint="Deletes the unreadable connection from this device and returns to setup"
            label="Clear it and set up again"
            onPress={() => {
              void disconnect();
            }}
          />
        </View>
        {footer === undefined ? null : <View className="pt-4">{footer}</View>}
      </View>
    </ScrollView>
  );
}
