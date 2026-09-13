import { Text, View } from 'react-native';

import { gutter } from '../../../ui/theme';

/**
 * The web build, saying what it cannot do.
 *
 * A Raphael key grants full access to someone's second brain, and the only places a browser offers
 * to keep one - `localStorage`, a cookie, IndexedDB - are readable by any script that runs on the
 * origin. Putting it in one of them and calling the connection saved would be the app lying about
 * the one thing it must not lie about. Asking for the key on every reload instead would still leave
 * it in memory in a document that other scripts share.
 *
 * So the web build says so, in full, and stops. It is not a degraded mode and not a warning over a
 * working screen. The server also has no CORS support today, so a browser could not reach it even
 * if the key had somewhere to live; both facts are here because either one alone would be a
 * half-explanation.
 */
export function UnsupportedPlatform() {
  return (
    <View className="flex-1 items-center justify-center bg-canvas" style={{ padding: gutter }}>
      <View className="max-w-[420px] gap-3">
        <Text
          accessibilityRole="header"
          className="font-heading text-[28px] leading-[34px] text-ink"
        >
          Raphael needs a phone for now.
        </Text>
        <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
          This app keeps your server key in the device keychain. A browser has nowhere equivalent —
          every option it offers can be read by other scripts on the same page — and Raphael will
          not put a key that opens your whole second brain somewhere like that.
        </Text>
        <Text className="font-body text-[16px] leading-[23px] text-ink-soft">
          The server does not accept browser requests yet either, so there is nothing here to
          connect to even without the key. Open Raphael on Android or iOS.
        </Text>
      </View>
    </View>
  );
}
