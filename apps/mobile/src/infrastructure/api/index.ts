/**
 * The backend boundary.
 *
 * Two things sit behind it and they are not the same kind of thing. `buildTransport` reaches the
 * connected Raphael server, which owns areas and projects. `localContent` is session-only data
 * this release has no server operation for. Capability `client/` directories use these; nothing
 * else does, and no feature reaches past them.
 */
export {
  buildTransport,
  isTransportRejection,
  type Transport,
  type TransportRejection,
} from './transport';
export { localContent } from '../mocks/local';
