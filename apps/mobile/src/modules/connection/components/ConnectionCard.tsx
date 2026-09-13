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
 * what verification actually established, but it is a fact about two programs agreeing, not
 * something the owner of one server has any use for or any way to act on.
 */
export function ConnectionCard({ connection }: ConnectionCardProps) {
  const forgotten = !connection.remembered;

  return (
    <View className="gap-3 rounded-card border border-line bg-card p-4">
      <View className="flex-row items-center gap-2.5">
        <View
          className={
            forgotten ? 'h-2 w-2 rounded-full bg-danger' : 'h-2 w-2 rounded-full bg-primary'
          }
        />
        <Text className="font-heading text-[16px] leading-[22px] text-ink">
          {forgotten ? 'Connected, but not saved' : 'Connected'}
        </Text>
      </View>

      <View className="gap-0.5">
        <Row label="Address" value={connection.origin} />
        <Row
          label="API key"
          value={forgotten ? 'Held until you close the app' : 'Saved on this device'}
        />
      </View>

      {forgotten ? (
        // Deliberately neutral about why the key is not saved. Nothing writes to secure storage in
        // this phase, so blaming a failed write would name an event that never happened. Phase 08
        // attempts a real write, and only then is "we tried and could not" a state that exists and
        // a different thing to say than "we have not tried"; splitting the two before the write
        // exists would be inventing a distinction the app cannot yet make.
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-[14px] leading-[20px] text-ink-soft"
        >
          This key is not stored anywhere, so Raphael will ask for it again next time you open the
          app. Everything works until then.
        </Text>
      ) : null}
    </View>
  );
}
