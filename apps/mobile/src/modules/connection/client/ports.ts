/**
 * The connection store's contact with the outside world: the transport factory, the cache and the
 * session-only content store. `state/` takes these as ports, so its transitions run under a test.
 */

import type { Transport } from '@raphael/client';

import { buildTransport, isTransportRejection, localContent } from '../../../infrastructure/api';
import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { queryClient } from '../../../infrastructure/query/query-client';
import { noteResult, onBackOnline } from '../state/reachability';
import type { ConnectionPorts } from '../state/transition';

/**
 * The reachability chokepoint: every request the connected session makes reports its result here.
 * Setup's verification builds its own transport and does not, since a server being set up is not
 * the one the app depends on.
 */
const observed = (transport: Transport): Transport => ({
  ...transport,
  invoke: async (call) => {
    const result = await transport.invoke(call);

    noteResult(result);

    return result;
  },
});

export const createTransportPort: ConnectionPorts['createTransport'] = (base, apiKey) => {
  const transport = buildTransport(base, apiKey);

  return isTransportRejection(transport)
    ? { ok: false, message: transport.message }
    : { ok: true, transport: observed(transport) };
};

export const retireCaches: ConnectionPorts['retireCaches'] = () => {
  void queryClient.cancelQueries();
  queryClient.clear();
};

export const forgetLocalContent: ConnectionPorts['forgetLocalContent'] = (connectionId) => {
  localContent.forget(connectionId);
};

/** What was on screen may be out of date once the server answers again. */
export const refreshWhenBackOnline = (activation: () => number | null): (() => void) =>
  onBackOnline(() => {
    const current = activation();

    if (current !== null) void invalidateActivation(queryClient, current);
  });
