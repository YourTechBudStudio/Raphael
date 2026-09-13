import { goBack } from '../../navigation';
import { useConnectionStore } from '../state/connection';
import { SetupScreen } from './SetupScreen';

/**
 * Pointing this device at a different server, or at the same one with a new key.
 *
 * The same screen as first-run setup, because it is the same five conditions against an address.
 * What differs is what is at stake: there is a working connection already, and it stays untouched
 * until a new one has both answered and been written down. Leaving early leaves it exactly as it
 * was, and so does a new server that answers but cannot be saved.
 *
 * Nothing here leaves the screen on success. The gate owns that: when the connection changes it
 * throws away the whole stack, because every screen behind this one names containers by ids that
 * belong to the server being replaced.
 */
export function ChangeServerScreen() {
  const phase = useConnectionStore((state) => state.phase);

  // Unreachable through the UI - the gate shows setup when there is no connection - but a deep
  // link is a way in, and rendering a replace screen with nothing to replace would be a lie.
  if (phase.kind !== 'active') return <SetupScreen />;

  return <SetupScreen onCancel={goBack} replacing={phase.session.connection} />;
}
