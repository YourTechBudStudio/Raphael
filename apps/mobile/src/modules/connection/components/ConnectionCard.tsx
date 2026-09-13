import { Text, View } from 'react-native';

import type { Connection } from '../state/connection';

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <View className="min-h-[34px] flex-row items-start gap-4">
      <Text className="w-[76px] font-body-medium text-[14px] leading-[22px] text-ink-soft">
        {label}
      </Text>
      <Text className="flex-1 text-right font-body text-[15px] leading-[22px] text-ink">
        {value}
      </Text>
    </View>
  );
}

/**
 * Where the key is, and why, when the answer is not simply "saved".
 *
 * There are three causes and they are genuinely different things to say, so they are modelled
 * separately even though two of them share a heading. "We tried and the keychain refused" and
 * "there is no keychain on this platform" are not the same event, and collapsing them would leave
 * one of the two people who hit them with an explanation that does not match what happened.
 */
const storageCopy = (
  connection: Connection,
): { readonly saved: boolean; readonly where: string; readonly detail: string | null } => {
  switch (connection.storage.kind) {
    case 'saved':
      return { saved: true, where: 'Saved on this device', detail: null };
    case 'write_failed':
      return {
        saved: false,
        where: 'Held until you close the app',
        detail: `This device's secure storage would not accept the key, so it is only in memory. ${connection.storage.message} Raphael will ask for it again next time you open the app.`,
      };
    case 'unsupported':
      return {
        saved: false,
        where: 'Held until you close the app',
        detail:
          'This platform has no secure storage, so nothing was written. Raphael will ask for the key again next time.',
      };
  }
};

export interface ConnectionCardProps {
  connection: Connection;
}

/**
 * The server this device is talking to.
 *
 * The key is never shown, not even in part. There is one key and one server, so a fingerprint
 * would identify nothing the address does not already identify, and the smallest disclosure that
 * buys nothing is still a disclosure. What the card reports instead is where the key *is*, which
 * is the thing that can actually differ between two otherwise identical connections.
 *
 * The protocol version is deliberately not here. It is recorded on the connection because it is
 * what verification established, but it is a fact about two programs agreeing, not something the
 * owner of one server has any use for or any way to act on - and it is historical besides: it says
 * what was true when the connection was made, not what is true now.
 */
export function ConnectionCard({ connection }: ConnectionCardProps) {
  const storage = storageCopy(connection);

  return (
    <View className="gap-3 rounded-card border border-line bg-card p-4">
      <View className="flex-row items-center gap-2.5">
        <View
          className={
            storage.saved ? 'h-2 w-2 rounded-full bg-primary' : 'h-2 w-2 rounded-full bg-danger'
          }
        />
        <Text className="font-heading text-[16px] leading-[22px] text-ink">
          {storage.saved ? 'Connected' : 'Connected, but not saved'}
        </Text>
      </View>

      <View className="gap-0.5">
        <Row label="Address" value={connection.origin} />
        <Row label="API key" value={storage.where} />
      </View>

      {storage.detail === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-[14px] leading-[20px] text-ink-soft"
        >
          {storage.detail}
        </Text>
      )}
    </View>
  );
}
