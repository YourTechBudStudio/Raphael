import { goBack } from '../../navigation';
import { useConnectionStore } from '../state/connection';
import { SetupScreen } from './SetupScreen';

/**
 * Pointing this device at a different server.
 *
 * The same screen as first-run setup, because it is the same five conditions against a new
 * address. What differs is what is at stake: there is a working connection already, and it stays
 * untouched until a new server has answered. Leaving early leaves it exactly as it was.
 */
export function ChangeServerScreen() {
  const connection = useConnectionStore((state) => state.connection);

  // Unreachable through the UI - the gate shows setup when there is no connection - but a deep
  // link is a way in, and rendering a replace screen with nothing to replace would be a lie.
  if (connection === null) return <SetupScreen />;

  return <SetupScreen onCancel={goBack} onReplaced={goBack} replacing={connection} />;
}
