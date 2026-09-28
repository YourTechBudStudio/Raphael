import { SettingsScreen } from '../modules/connection';
import { discardAllUnsent, useUnsentCount } from '../modules/unsent';

/** Disconnecting discards unsent writing too, so the route composes the two. */
export default function Settings() {
  const unsent = useUnsentCount();

  return <SettingsScreen onDiscardUnsent={discardAllUnsent} unsent={unsent} />;
}
