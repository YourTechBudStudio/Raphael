import { ArrowLeftRight, ChevronLeft, RotateCcw, Unplug } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { confirmDiscard, DiscAction, IconButton, Screen } from '../../../ui';
import { goBack, openChangeServer } from '../../navigation';
import { useRejectionRetry } from '../client/rejection';
import { useConnectionStore } from '../state/connection';
import { ConnectionMap } from './ConnectionMap';

export interface SettingsScreenProps {
  /** Unsent writing on this phone, which disconnecting discards. Composed by the route. */
  unsent?: number | undefined;
  /** Answers whether the writing is gone; if not, nothing disconnects. */
  onDiscardUnsent?: (() => Promise<boolean>) | undefined;
}

/**
 * Settings: one section today, and the only one this slice has any business offering.
 *
 * There is no save button. The connection is changed by establishing a new one, which is its own
 * screen, and it is removed by disconnecting, which asks first. Nothing here edits in place,
 * because a half-edited connection is a state the rest of the app would have to understand.
 *
 * There is no "On this phone" section either. Unfinished is reached from the one place that knows
 * whether there is anything in it: the chip beside Home's Notes heading, drawn only when it is true.
 *
 * No cards: the connection is drawn as a small map, and the actions are round buttons under it. A
 * refusal is shown on the map itself rather than in the notice other screens carry, because here
 * the map is already the statement about the connection, and Try again joins the actions.
 */
export function SettingsScreen({ unsent = 0, onDiscardUnsent }: SettingsScreenProps = {}) {
  const phase = useConnectionStore((state) => state.phase);
  const disconnect = useConnectionStore((state) => state.disconnect);
  const [notDiscarded, setNotDiscarded] = useState(false);
  const { checking, retry } = useRejectionRetry();

  const connection = phase.kind === 'active' ? phase.session.connection : null;
  const rejection = phase.kind === 'active' ? phase.rejection : null;

  const onDisconnect = (): void => {
    const discarded =
      unsent === 0
        ? ''
        : ` ${unsent === 1 ? 'The 1 unfinished note' : `The ${String(unsent)} unfinished notes`} on this phone ${unsent === 1 ? 'is' : 'are'} discarded too.`;

    void confirmDiscard({
      title: 'Disconnect from this server?',
      message: `Raphael will forget the address and the key, and ask for them again. Notes and stars kept on this device go with it.${discarded} Nothing on the server is changed or deleted.`,
      keepLabel: 'Stay connected',
      discardLabel: 'Disconnect',
    }).then(async (confirmed) => {
      if (!confirmed) return;

      // One server per phone: writing meant for this one must be gone before any other is set up.
      // Always, not only when something was counted: a write can land after the count was read.
      const gone = (await onDiscardUnsent?.()) ?? true;

      setNotDiscarded(!gone);
      if (!gone) return;

      // Nothing is done with the outcome here on purpose. Disconnecting changes the phase, the gate
      // swaps this screen out for setup immediately, and a warning stored in this component would
      // be rendered by nothing. A failed deletion is recorded on the connection phase and said on
      // the setup screen, which is the screen that exists by the time the answer arrives.
      void disconnect();
    });
  };

  return (
    <Screen
      captureBar={false}
      contentContainerStyle={{ flexGrow: 1 }}
      header={
        <View className="h-14 flex-row items-center">
          <IconButton icon={ChevronLeft} label="Back" onPress={goBack} />
        </View>
      }
    >
      <View className="flex-1 gap-8">
        <Text
          accessibilityRole="header"
          className="font-heading text-[34px] leading-[42px] text-ink"
        >
          Settings
        </Text>

        {connection === null ? null : (
          <ConnectionMap connection={connection} rejection={rejection} />
        )}

        <View className="gap-3">
          <View className="flex-row flex-wrap gap-x-5 gap-y-4">
            {rejection === null ? null : (
              <DiscAction
                accessibilityHint="Asks the server whether it accepts this phone now"
                disabled={checking}
                icon={RotateCcw}
                label={checking ? 'Checking…' : 'Try again'}
                onPress={retry}
                tone="primary"
              />
            )}
            <DiscAction
              accessibilityHint="Points this device at a different server"
              icon={ArrowLeftRight}
              label="Change server"
              onPress={openChangeServer}
            />
            <DiscAction
              accessibilityHint="Forgets this server and returns to setup"
              icon={Unplug}
              label="Disconnect"
              onPress={onDisconnect}
              tone="danger"
            />
          </View>
          {notDiscarded ? (
            <Text
              accessibilityLiveRegion="assertive"
              className="font-body text-[14px] leading-[20px] text-danger"
            >
              Raphael could not remove the unfinished notes from this phone, so it stayed connected.
            </Text>
          ) : null}
        </View>

        <View className="flex-1 justify-end">
          <Text className="font-body text-[14px] leading-[20px] text-ink-soft">
            One server, one key, one brain. There is not much to configure yet, and that is on
            purpose.
          </Text>
        </View>
      </View>
    </Screen>
  );
}
