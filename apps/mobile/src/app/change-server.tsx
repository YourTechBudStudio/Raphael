import { useEffect } from 'react';

import { ChangeServerScreen, useReachability } from '../modules/connection';
import { discardAllUnsent, resumeUnsent, useUnsentCount } from '../modules/unsent';

/** Composed here because the warning needs both the connection and the unsent writing. */
export default function ChangeServer() {
  const reachable = useReachability((state) => state.online);
  const unsent = useUnsentCount();

  // Leaving without switching lets this server's screens write again; a switch already has.
  useEffect(() => resumeUnsent, []);

  return (
    <ChangeServerScreen
      currentReachable={reachable}
      onDiscardUnsent={discardAllUnsent}
      unsent={unsent}
    />
  );
}
