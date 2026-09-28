import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { gutter } from '../../../ui';
import { useUnsentStatus } from '../../unsent';

/**
 * The app keeps unsent writing in SQLite, so it does not open without it: nothing is drawn until it
 * is open, so no screen can count or switch away from writing it has not read yet. There is no
 * repair flow: a failure says so and stops.
 */
export function StorageGate({ children }: { children: ReactNode }) {
  const status = useUnsentStatus();

  if (status === 'ready') return <>{children}</>;
  if (status === 'opening') return <View className="flex-1 bg-canvas" />;

  return (
    <View className="flex-1 items-center justify-center bg-canvas" style={{ padding: gutter }}>
      <View className="max-w-[420px] gap-3">
        <Text
          accessibilityRole="header"
          className="font-heading text-[28px] leading-[34px] text-ink"
        >
          Couldn’t open storage on this phone.
        </Text>
        <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
          Raphael keeps what you write here until your server has it, and it could not open that
          storage. Close Raphael and open it again.
        </Text>
      </View>
    </View>
  );
}
