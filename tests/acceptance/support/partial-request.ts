/**
 * A request that is deliberately only half-sent, so a shutdown can land in the middle of it.
 *
 * `fetch` cannot do this: it hands over a complete request and gives back a promise, so anything
 * built on it can only signal *before* the request or *after* the answer, and "after the answer" is
 * not a shutdown during active work however the test is named. A raw socket can hold a request open
 * at a chosen point - headers delivered, body incomplete - which is the only way to put a signal
 * genuinely inside the window from outside the process.
 *
 * The window this opens is the one that matters for the drain. A connection that has sent nothing is
 * closed immediately at shutdown; a connection whose bytes have arrived, parsed or not, is left to
 * the drain instead of being reset. This puts the connection in the second state on purpose.
 */

import { connect, type Socket } from 'node:net';

/**
 * The longest this waits for an answer.
 *
 * A shutdown that never answers is a regression this test exists to catch, so the wait is bounded and
 * the socket is destroyed on expiry. Long enough to clear the backend's own drain deadline, short
 * enough that a stuck server is reported rather than waited on.
 */
const RESPONSE_DEADLINE_MS = 30_000;

export interface HalfSent {
  /** Everything the server has said so far, as text. */
  readonly received: () => string;
  /** Send the rest of the body. */
  readonly finish: () => void;
  /** Resolves when the server closes the connection, with everything it said. Bounded. */
  readonly response: Promise<string>;
  readonly socket: Socket;
}

/**
 * Open a connection, send the headers and the first byte of the body, and stop there.
 *
 * `Connection: close` so the response ends at the close and there is no keep-alive to wait out.
 * Exactly one byte is held back: enough that the request is genuinely incomplete, small enough that
 * finishing it is a single write and never approaches the receive deadline that exists to destroy
 * requests which stall.
 */
export const halfSendPost = (
  port: number,
  path: string,
  key: string,
  body: string,
): Promise<HalfSent> =>
  new Promise((resolveOpen, rejectOpen) => {
    const payload = Buffer.from(body, 'utf8');
    const head =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Authorization: Bearer ${key}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${payload.byteLength}\r\n` +
      `Connection: close\r\n\r\n`;

    const socket = connect({ port, host: '127.0.0.1' });
    let received = '';

    const response = new Promise<string>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        socket.destroy();
        rejectResponse(
          new Error(
            `no answer within ${RESPONSE_DEADLINE_MS}ms; the server said: ` +
              `${JSON.stringify(received.slice(0, 200))}`,
          ),
        );
      }, RESPONSE_DEADLINE_MS);
      socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
      socket.on('close', () => {
        clearTimeout(timer);
        resolveResponse(received);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        rejectResponse(error);
      });
    });

    socket.on('error', rejectOpen);
    socket.on('connect', () => {
      socket.write(head);
      socket.write(payload.subarray(0, payload.byteLength - 1));
      resolveOpen({
        received: () => received,
        finish: () => socket.write(payload.subarray(payload.byteLength - 1)),
        response,
        socket,
      });
    });
  });

/** The status line's code, or null if nothing resembling a response arrived. */
export const statusOf = (raw: string): number | null => {
  const match = /^HTTP\/1\.1 (\d{3})/.exec(raw);
  return match?.[1] === undefined ? null : Number(match[1]);
};
