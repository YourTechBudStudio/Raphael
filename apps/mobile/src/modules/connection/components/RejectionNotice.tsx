import { Text, View } from 'react-native';

import { queryClient } from '../../../infrastructure/query/query-client';
import { Chip } from '../../../ui';
import { openChangeServer } from '../../navigation';
import { useConnectionStore } from '../state/connection';

export interface RejectionNoticeProps {
  className?: string | undefined;
}

/**
 * The connection itself is the problem, said once, on the screen the person is looking at.
 *
 * Not only in Settings. A refused key makes every read fail, and a screen full of "this did not
 * load" with the explanation two taps away is how someone concludes their notes are gone. It sits
 * above the content on the screens that read the server, and says nothing at all the rest of the
 * time.
 *
 * It offers, and never acts on its own. The key is not deleted, the connection is not dropped, and
 * nothing retries in a loop behind it: a refusal and a version mismatch are both settled answers,
 * and asking the same question faster does not change either. Trying again is a decision, so it is
 * a button.
 */
export function RejectionNotice({ className }: RejectionNoticeProps) {
  const phase = useConnectionStore((state) => state.phase);
  const clearRejection = useConnectionStore((state) => state.clearRejection);

  if (phase.kind !== 'active' || phase.rejection === null) return null;

  const unauthorized = phase.rejection === 'unauthorized';

  return (
    <View
      accessibilityLiveRegion="polite"
      className={[
        'gap-2 rounded-card border border-danger bg-card px-4 py-3',
        className ?? '',
      ].join(' ')}
    >
      <Text accessibilityRole="header" className="font-heading text-[16px] leading-[22px] text-ink">
        {unauthorized ? 'That key was refused.' : 'A different version of Raphael.'}
      </Text>
      <Text className="font-body text-[15px] leading-[21px] text-ink-soft">
        {unauthorized
          ? 'The server answered, and it does not accept the key this device is holding. Nothing has been deleted here, and nothing on the server has changed.'
          : 'The server answered with a protocol this app does not understand. One of the two needs updating; nothing here is broken.'}
      </Text>
      <View className="flex-row flex-wrap gap-2 pt-1">
        <Chip
          accessibilityHint="Reads everything on this screen again"
          label="Try again"
          onPress={() => {
            clearRejection();
            void queryClient.refetchQueries();
          }}
        />
        <Chip
          accessibilityHint="Points this device at a different server, or re-enters the key"
          label="Change server"
          onPress={openChangeServer}
        />
      </View>
    </View>
  );
}
