import type { ReactNode } from 'react';

import { useConnectionStore } from '../state/connection';
import { SetupScreen } from './SetupScreen';

export interface ConnectionGateProps {
  children: ReactNode;
}

/**
 * Nothing runs until this device has a verified server.
 *
 * A gate rather than an empty state on each screen: areas and projects are the app's real content,
 * and a half-populated Raphael showing mock notes beside an unreachable hierarchy is the kind of
 * screen nobody can read the truth off.
 */
export function ConnectionGate({ children }: ConnectionGateProps) {
  const connection = useConnectionStore((state) => state.connection);

  return connection === null ? <SetupScreen /> : <>{children}</>;
}
