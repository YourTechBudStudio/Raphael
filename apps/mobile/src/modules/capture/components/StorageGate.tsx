import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { colors, PrimaryButton } from '../../../ui';
import { useCaptureOwner } from '../client/owner.ts';
import { useStorageGate } from '../state/storage-gate.ts';

const UNOPENABLE =
  'Raphael keeps what you write on this phone before it goes anywhere, and it cannot open its record of that right now. Nothing has been removed, and nothing has been reset.';
const UNSUPPORTED =
  'This phone holds notes written by a newer version of Raphael. Nothing has been changed or removed; update the app to open them.';
const NO_DRAFT =
  'Raphael could not start a new note on this phone. Nothing has been removed, and nothing has been reset.';

/**
 * Nothing opens until this phone can keep what someone writes.
 *
 * One screen, not a degraded app. The alternative - a Home that loads, a composer that opens and a
 * save that cannot be protected - is a phone that looks like it is working while the one guarantee
 * capture makes is not being kept. The decision is frozen in the UI decisions: this is rare, and
 * simplicity wins over graceful handling.
 *
 * It sits **inside** the connection gate. Setup is the only surface while there is no connection,
 * and no recovery, copy or discard is reachable before one exists - so a storage error never becomes
 * a way around setup, and setup never hides a storage error from someone who is already connected.
 *
 * Retrying is offered for an open that failed and withheld for a database written by a newer build,
 * which is not something a second attempt can fix.
 */
export function StorageGate({ children }: { children: ReactNode }) {
  const status = useCaptureOwner((state) => state.status);
  const problem = useCaptureOwner((state) => state.problem);
  const retryOpen = useCaptureOwner((state) => state.retryOpen);
  const fatal = useStorageGate((state) => state.fatal);

  if (status === 'ready' && !fatal) return <>{children}</>;

  if (status === 'idle' || status === 'opening') {
    return (
      <View className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator accessibilityLabel="Opening Raphael" color={colors.primary} />
      </View>
    );
  }

  const unsupported = problem?.kind === 'unsupported_version';
  // The store opened and then could not hold a new note. Reopening it is not the remedy and would
  // do nothing - it is already open - so no retry is offered rather than a button that answers no.
  const draftFailed = fatal && status === 'ready';
  const message = draftFailed ? NO_DRAFT : unsupported ? UNSUPPORTED : UNOPENABLE;

  return (
    <View className="flex-1 justify-center gap-4 bg-canvas px-6">
      <Text accessibilityRole="header" className="font-heading text-[26px] leading-[32px] text-ink">
        Raphael cannot open.
      </Text>
      <Text
        accessibilityLiveRegion="assertive"
        className="font-body text-[16px] leading-[24px] text-ink-soft"
      >
        {message}
      </Text>
      {unsupported || draftFailed ? null : (
        <PrimaryButton
          accessibilityHint="Tries to open this phone’s record of your notes again"
          label="Try again"
          onPress={() => {
            void retryOpen();
          }}
        />
      )}
    </View>
  );
}
