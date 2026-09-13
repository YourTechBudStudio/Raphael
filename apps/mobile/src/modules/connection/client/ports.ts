/**
 * The connection store's contact with the outside world.
 *
 * Here rather than beside the store because this is where backend bindings belong: the transport
 * factory and the session-only content store are both boundary objects, and the capability's rule
 * is that `client/` owns them. What is left in `state/` is the transition logic, which takes these
 * as ports and therefore runs under a test with neither.
 */

import { buildTransport, isTransportRejection, localContent } from '../../../infrastructure/api';
import { queryClient } from '../../../infrastructure/query/query-client';
import type { ConnectionPorts } from '../state/transition';

export const createTransportPort: ConnectionPorts['createTransport'] = (base, apiKey) => {
  const transport = buildTransport(base, apiKey);

  return isTransportRejection(transport)
    ? { ok: false, message: transport.message }
    : { ok: true, transport };
};

export const retireCaches: ConnectionPorts['retireCaches'] = () => {
  void queryClient.cancelQueries();
  queryClient.clear();
};

export const forgetLocalContent: ConnectionPorts['forgetLocalContent'] = (connectionId) => {
  localContent.forget(connectionId);
};
