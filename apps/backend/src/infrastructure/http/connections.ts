import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { Deadlines } from './deadlines.ts';

/**
 * The connections: their receive deadlines, and which of them are safe to close during shutdown.
 *
 * **Why the deadlines are here rather than left to Node.** `headersTimeout` and `requestTimeout` do
 * not bound every case, and the difference was measured rather than assumed. On this Node version,
 * with `connectionsCheckingInterval` set to one second:
 *
 * | Client behavior                       | Node's properties alone | With the timers below |
 * | ------------------------------------- | ----------------------- | --------------------- |
 * | connects, sends nothing at all        | held open indefinitely  | destroyed             |
 * | sends part of its headers, then stops | destroyed               | destroyed             |
 * | completes headers, never sends a body | held open indefinitely  | destroyed             |
 * | trickles a body and stalls            | held open indefinitely  | destroyed             |
 *
 * Two of those matter most for a server that authenticates before reading a body: an authenticated
 * caller who stalls mid-upload would otherwise hold a connection indefinitely, and a socket that
 * never speaks would hold one without ever becoming a request. Setting the properties and calling the
 * lifecycle bounded would have been exactly the mistake of treating an assignment as evidence. Node's
 * properties are still set by the caller - they are the documented mechanism and they do fire for the
 * partial-headers case - but these timers are what make the guarantee.
 *
 * **Why shutdown needs to know about sockets at all.** `server.closeIdleConnections()` destroys every
 * connection not currently handling a request, and a request whose bytes are in the kernel buffer but
 * not yet parsed is indistinguishable from an idle one. Measured: a complete request written
 * immediately before shutdown was reset rather than answered, even after yielding a turn first. The
 * caller could not tell that from a network cut, so a creation they had in fact sent would become an
 * outcome they had to go and check.
 *
 * A socket that has produced data but not yet a finished response is *not* quiet, and that is
 * observable here. So shutdown closes the quiet ones - which are holding nothing - and leaves the
 * rest to the drain, where they finish or are closed at the deadline like any other stalled peer.
 *
 * Every timer is unref'd, so none keeps the process alive on its own, and each is cleared on every
 * path that ends what it was watching. As with any same-thread timer, the bound is the configured
 * duration plus scheduling delay, and nothing fires while synchronous work holds the thread.
 */

export interface ConnectionRegistry {
  /**
   * Destroy connections that have said nothing since their last completed response. A connection
   * mid-request, or one whose bytes have arrived and not yet been parsed, is left alone.
   */
  readonly closeQuiet: () => void;
  /** How many connections are currently mid-request. Diagnostics only. */
  readonly speaking: () => number;
}

/** Arm a one-shot deadline, and return the function that cancels it. */
const deadline = (ms: number, onExpiry: () => void): (() => void) => {
  const timer = setTimeout(onExpiry, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export const bindConnections = (server: Server, deadlines: Deadlines): ConnectionRegistry => {
  // `speaking` is the set of sockets that have sent bytes we have not finished answering.
  const speaking = new Set<Socket>();
  const open = new Set<Socket>();

  server.on('connection', (socket: Socket) => {
    open.add(socket);

    // A connection that has not said anything yet is not a request, and no HTTP-level timer is
    // watching it. Destroying it is the only truthful response: there is no request to answer.
    const cancelHeaders = deadline(deadlines.headersMs, () => socket.destroy());

    // One persistent listener for the life of the socket, deliberately not a `once` re-armed after
    // each response: a keep-alive connection serves many requests, and re-arming would add a listener
    // per exchange until Node warned about a leak. Re-cancelling an already-cancelled deadline is
    // harmless, so this stays simple.
    socket.on('data', () => {
      cancelHeaders();
      speaking.add(socket);
    });

    socket.once('close', () => {
      cancelHeaders();
      open.delete(socket);
      speaking.delete(socket);
    });
  });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    speaking.add(request.socket);
    // From here the deadline is on *receiving* the request, not on handling it. It is cleared when
    // the body has fully arrived, when the request is abandoned, or when the response is over -
    // whichever happens first - so a slow operation is never cut short by a receive deadline.
    const cancel = deadline(deadlines.requestMs, () => request.socket.destroy());
    request.once('end', cancel);
    request.once('close', cancel);
    response.once('close', () => {
      cancel();
      // The exchange is over. Until the peer sends again - which the persistent `data` listener above
      // observes - this connection is holding nothing and shutdown may close it.
      speaking.delete(request.socket);
    });
  });

  // A malformed request line, an oversized header, or Node's own request timeout arrives here. There
  // is no envelope worth writing - the peer has not made a request we could answer - and the error
  // carries parser detail about bytes we will not reflect, so the connection is closed and nothing
  // from the error is read.
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });

  return {
    speaking: () => speaking.size,
    closeQuiet: () => {
      for (const socket of open) {
        if (!speaking.has(socket)) socket.destroy();
      }
    },
  };
};
