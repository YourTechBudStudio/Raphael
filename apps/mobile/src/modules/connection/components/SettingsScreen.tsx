import { Text, View } from 'react-native';

import { Chip, confirmDiscard, Screen, SectionHeading } from '../../../ui';
import { goBack, openChangeServer, TitleTopBar } from '../../navigation';
import { useConnectionStore } from '../state/connection';
import { ConnectionCard } from './ConnectionCard';

/**
 * Settings: one section today, and the only one this slice has any business offering.
 *
 * There is no save button. The connection is changed by establishing a new one, which is its own
 * screen, and it is removed by disconnecting, which asks first. Nothing here edits in place,
 * because a half-edited connection is a state the rest of the app would have to understand.
 */
export function SettingsScreen() {
  const connection = useConnectionStore((state) => state.connection);
  const disconnect = useConnectionStore((state) => state.disconnect);

  const onDisconnect = (): void => {
    void confirmDiscard({
      title: 'Disconnect from this server?',
      message:
        'Raphael will forget the address and the key, and ask for them again. Nothing on the server is changed or deleted.',
      keepLabel: 'Stay connected',
      discardLabel: 'Disconnect',
    }).then((confirmed) => {
      if (confirmed) disconnect();
    });
  };

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Settings" />}>
      <View className="gap-7 pt-2">
        <View className="gap-3">
          <SectionHeading>Connection</SectionHeading>
          {connection === null ? null : <ConnectionCard connection={connection} />}
          <View className="flex-row flex-wrap gap-2">
            <Chip
              accessibilityHint="Points this device at a different server"
              label="Change server"
              onPress={openChangeServer}
            />
            <Chip
              accessibilityHint="Forgets this server and returns to setup"
              label="Disconnect"
              onPress={onDisconnect}
            />
          </View>
        </View>

        <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
          One server, one key, one brain. There is not much to configure yet, and that is on
          purpose.
        </Text>
      </View>
    </Screen>
  );
}
