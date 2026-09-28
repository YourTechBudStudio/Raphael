import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { openChangeServer } from '../../navigation';
import { refreshWhenBackOnline } from '../client/ports';
import { checkServer } from '../client/verify';
import { useConnectionSession, useConnectionStore } from '../state/connection';
import { useReachability } from '../state/reachability';
import { OfflineScreen } from './OfflineScreen';

const CHECK_EVERY_S = 10;

export interface OfflineGateProps {
  children: ReactNode;
  /**
   * The current route keeps working offline: the composer and the editor keep writing on the phone,
   * and Change server is how someone gets out. The gate appears when they navigate away.
   */
  exempt: boolean;
}

/**
 * "Can't reach your server" over everything, while the server does not answer.
 *
 * It checks again every ten seconds while offline. A check that gets any answer brings the app back
 * through reachability, which also refreshes what was on screen and wakes the unsent runner.
 */
export function OfflineGate({ children, exempt }: OfflineGateProps) {
  const online = useReachability((state) => state.online);
  const session = useConnectionSession();
  const [checking, setChecking] = useState(false);
  const [seconds, setSeconds] = useState(CHECK_EVERY_S);

  useEffect(
    () =>
      refreshWhenBackOnline(() => {
        const { phase } = useConnectionStore.getState();

        return phase.kind === 'active' ? phase.session.activation : null;
      }),
    [],
  );

  useEffect(() => {
    if (online) return;

    setSeconds(CHECK_EVERY_S);
    const tick = setInterval(() => {
      setSeconds((value) => value - 1);
    }, 1_000);

    return () => {
      clearInterval(tick);
    };
  }, [online]);

  const check = (): void => {
    if (session === null || checking) return;

    setChecking(true);
    void checkServer(session.transport).finally(() => {
      setChecking(false);
      setSeconds(CHECK_EVERY_S);
    });
  };

  useEffect(() => {
    if (!online && seconds <= 0) check();
  });

  return (
    <>
      {children}
      {online || exempt || session === null ? null : (
        <View style={StyleSheet.absoluteFill}>
          <OfflineScreen
            checking={checking}
            onChangeServer={openChangeServer}
            onTryNow={check}
            origin={session.connection.origin}
            secondsUntilCheck={Math.max(seconds, 0)}
          />
        </View>
      )}
    </>
  );
}
