import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { Chip, confirmDiscard, Screen, SectionHeading } from '../../../ui';
import { goBack, openChangeServer, openRecovery, TitleTopBar } from '../../navigation';
import { useConnectionStore } from '../state/connection';
import { ConnectionCard } from './ConnectionCard';
import { RejectionNotice } from './RejectionNotice';

/**
 * Settings: one section today, and the only one this slice has any business offering.
 *
 * There is no save button. The connection is changed by establishing a new one, which is its own
 * screen, and it is removed by disconnecting, which asks first. Nothing here edits in place,
 * because a half-edited connection is a state the rest of the app would have to understand.
 */
export function SettingsScreen() {
  const phase = useConnectionStore((state) => state.phase);
  const disconnect = useConnectionStore((state) => state.disconnect);

  const connection = phase.kind === 'active' ? phase.session.connection : null;

  const onDisconnect = (): void => {
    void confirmDiscard({
      title: 'Disconnect from this server?',
      message:
        'Raphael will forget the address and the key, and ask for them again. Notes and stars kept on this device go with it. Creations it could not finish are kept and stay listed under Unfinished. Nothing on the server is changed or deleted.',
      keepLabel: 'Stay connected',
      discardLabel: 'Disconnect',
    }).then((confirmed) => {
      if (!confirmed) return;

      // Nothing is done with the outcome here on purpose. Disconnecting changes the phase, the gate
      // swaps this screen out for setup immediately, and a warning stored in this component would
      // be rendered by nothing. A failed deletion is recorded on the connection phase and said on
      // the setup screen, which is the screen that exists by the time the answer arrives.
      void disconnect();
    });
  };

  return (
    <Screen captureBar={false} header={<TitleTopBar onBack={goBack} title="Settings" />}>
      <View className="gap-7 pt-2">
        <RejectionNotice />

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

        <View className="gap-3">
          <SectionHeading>On this phone</SectionHeading>
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            Notes Raphael has not been able to finish are kept here until you resolve them,
            including any written against a server you have since left.
          </Text>
          <View className="flex-row">
            <Chip
              accessibilityHint="Opens every note left unfinished on this phone"
              label="Unfinished notes"
              onPress={openRecovery}
            />
          </View>
          {/* TEMPORARY PREVIEW for story #4; remove with app/preview. */}
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="Preview: unfinished edits"
              onPress={() => {
                router.push('/preview/unfinished-edits');
              }}
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
