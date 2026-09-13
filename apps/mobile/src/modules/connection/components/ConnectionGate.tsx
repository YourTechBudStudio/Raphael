import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { colors } from '../../../ui';
import { resetToHome } from '../../navigation';
import { useRejectionWatch } from '../client/rejection';
import { useConnectionStore } from '../state/connection';
import { NO_RETIREMENT_MEMORY, nextRetirement } from '../state/retirement';
import { SECURE_STORAGE_SUPPORTED } from '../state/secure-port';
import { SetupScreen } from './SetupScreen';
import { StoredConnectionProblem } from './StoredConnectionProblem';
import { UnsupportedPlatform } from './UnsupportedPlatform';

export interface ConnectionGateProps {
  children: ReactNode;
  /**
   * Rendered on the screens that stand in for the app when there is no usable connection.
   *
   * Those screens replace the whole router, so anything that must stay reachable without a server
   * cannot be a route and cannot be reached from Settings either. Composition passes it in rather
   * than this capability importing it, which would be a cycle and a boundary this module does not
   * need to cross.
   */
  unconnected?: ReactNode | undefined;
}

/**
 * Nothing runs until this device has a server.
 *
 * A gate rather than an empty state on each screen: areas and projects are the app's real content,
 * and a half-populated Raphael showing an unreachable hierarchy is a screen nobody can read the
 * truth off.
 *
 * "Has a server" means a stored configuration, not a successful handshake. The app opens offline,
 * on a flight, with the server switched off at home, and the screens report what they cannot reach.
 * Making the network a launch gate would mean an unreachable server locked someone out of an app
 * whose connection they might be trying to fix.
 *
 * The four storage states are kept apart on purpose. Reading and having read nothing are different
 * things - one is a spinner, the other is setup - and a keychain that cannot be read is not an
 * empty keychain, so it gets a screen that says so rather than being swept into first-run setup
 * where it would look like the connection had simply never existed.
 */
export function ConnectionGate({ children, unconnected }: ConnectionGateProps) {
  const phase = useConnectionStore((state) => state.phase);
  const hydrate = useConnectionStore((state) => state.hydrate);

  useRejectionWatch();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const activation = phase.kind === 'active' ? phase.session.activation : null;
  const retirement = useRef(NO_RETIREMENT_MEMORY);

  // `nextRetirement` owns the rule and is tested on its own; this is the part that cannot be, which
  // is why it holds nothing but a ref and a call.
  useEffect(() => {
    const step = nextRetirement(retirement.current, activation);
    retirement.current = step.memory;

    if (step.retire) resetToHome();
  }, [activation]);

  if (phase.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator accessibilityLabel="Opening Raphael" color={colors.primary} />
      </View>
    );
  }

  if (!SECURE_STORAGE_SUPPORTED) return <UnsupportedPlatform />;

  if (phase.kind === 'unreadable') {
    return <StoredConnectionProblem footer={unconnected} message={phase.message} />;
  }

  return phase.kind === 'active' ? <>{children}</> : <SetupScreen footer={unconnected} />;
}
