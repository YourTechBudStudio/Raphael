/**
 * Deterministic fault conditions for the phase 08 native transport probe.
 *
 * The real backend answers success and structured rejection; it cannot be asked to redirect, to
 * overrun the client's 32 MiB ceiling, or to stall its headers. This harness exists for exactly those
 * conditions, and for one property the client cannot observe about itself: what the *server* saw. A
 * client-side result says the transport reported a redirect refusal; only a counter on the redirect
 * target can say the credential never arrived there.
 *
 * Node-only. Started by a test, or by a human for the on-device run, and torn down by whoever started
 * it. Nothing here is shipped.
 */

import { createServer } from 'node:http';

/** Exceeds the shared client's RESPONSE_MAX_BYTES (32 MiB) without relying on that constant here. */
const OVERSIZE_TARGET_BYTES = 40 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

const listen = (server, host, port = 0) =>
  new Promise((resolve) => {
    server.listen(port, host, () => resolve(server.address().port));
  });

const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

/**
 * The redirect target. Counts every request that reaches it, and records whether an authorization
 * header came with it - a redirect that replays a credential is the disclosure this probe is for.
 */
export const startRedirectTarget = async (host, port = 0) => {
  const hits = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://placeholder');

    // Introspection is deliberately not counted, and is a GET so it can never be mistaken for the
    // POST the probe is watching for. The device-side probe reads observations over the wire, since
    // it cannot see into this process.
    if (request.method === 'GET' && url.pathname === '/observed') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ count: hits.length, hits }));
      return;
    }

    hits.push({
      id: url.searchParams.get('id'),
      path: url.pathname,
      method: request.method,
      hadAuthorization: request.headers.authorization !== undefined,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reached: true }));
  });
  const bound = await listen(server, host, port);
  return {
    port: bound,
    hits,
    get count() {
      return hits.length;
    },
    stop: () => close(server),
  };
};

/**
 * A minimal stand-in for Raphael's verification endpoint, so the two real-server checks can be
 * exercised without a real server. It answers exactly what the contract says: `{protocolVersion}` for
 * the configured key, and a 401 carrying the `unauthorized` error envelope for anything else.
 *
 * This exists because it was missing. The Node suite previously pinned only that `success` and
 * `rejection` *fail* with nothing behind the endpoint - which they did, while the rejection check
 * asserted a failure kind that does not exist. A check that has never been allowed to pass is not a
 * check, and only a device run found it.
 */
export const startFakeRaphael = async (host, key, port = 0) => {
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? '';
    const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    request.resume();

    if (presented !== key) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'A valid API key is required.', details: {} },
        }),
      );
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ protocolVersion: 1 }));
  });
  const bound = await listen(server, host, port);
  return { port: bound, stop: () => close(server) };
};

/**
 * The fault source. Every route is a single deliberate condition; `observed` records what the server
 * actually saw so a probe result can be checked against it rather than trusted.
 *
 * Every request carries an `?id=` the caller chose, and every observation is filed against it.
 *
 * - `POST /redirect`  302 to the target's `/landed`, carrying the id onward.
 * - `POST /oversize`  streams past the client ceiling, honouring backpressure, and records whether the
 *                     client closed the connection before the body finished.
 * - `POST /slow-headers`  never sends headers.
 * - `POST /slow-body`  sends headers, then a trickle, so a read can be cancelled mid-body.
 */
export const startFaultSource = async (host, targetPort, port = 0) => {
  // One record per request, never a cumulative flag. A shared boolean cannot say *which* request it
  // describes, which let a later check read an earlier request's closure as its own evidence. Every
  // observation here is attributable or it is not an observation.
  const observed = { records: [] };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://placeholder');
    const route = url.pathname;

    if (request.method === 'GET' && route === '/observed') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(observed));
      return;
    }

    const record = {
      id: url.searchParams.get('id'),
      route,
      method: request.method,
      closed: false,
      finished: false,
      bytesWritten: 0,
    };
    observed.records.push(record);
    request.resume();
    response.on('close', () => {
      record.closed = true;
    });

    if (route === '/redirect') {
      // The id travels with the redirect, so a landing at the target is attributable to this probe
      // rather than to anything else that happens to reach it.
      const query = record.id === null ? '' : `?id=${encodeURIComponent(record.id)}`;
      response.writeHead(302, { location: `http://${host}:${targetPort}/landed${query}` });
      response.end();
      return;
    }

    if (route === '/oversize') {
      response.writeHead(200, { 'content-type': 'application/json' });
      let stopped = false;
      response.on('close', () => {
        stopped = true;
      });
      const pump = () => {
        while (record.bytesWritten < OVERSIZE_TARGET_BYTES) {
          if (stopped) return;
          record.bytesWritten += CHUNK.length;
          // Respect backpressure: stop filling the kernel buffer and resume on drain.
          if (!response.write(CHUNK)) {
            response.once('drain', pump);
            return;
          }
        }
        if (stopped) return;
        record.finished = true;
        response.end();
      };
      pump();
      return;
    }

    if (route === '/slow-headers') {
      // Headers never sent. The request ends when the client gives up on it.
      return;
    }

    if (route === '/slow-body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"start"');
      const tick = setInterval(() => response.write(':1'), 50);
      response.on('close', () => clearInterval(tick));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'no such probe route' }));
  });

  const bound = await listen(server, host, port);
  return { port: bound, observed, stop: () => close(server) };
};
