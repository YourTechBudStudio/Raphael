/**
 * A proxy that loses a response on purpose, for human verification.
 *
 * Three of the phase 09 checks need a creation the server commits and the phone never hears about.
 * By hand that is a race nobody can win: stopping the server between the tap and the answer is a
 * coin flip, and turning off the radio usually kills the request before it lands. So this sits
 * between the phone and the server, forwards everything faithfully, and - when you arm it - waits
 * for the server to finish answering one creation and then drops the answer on the floor.
 *
 * That is the real fault. The node exists, the replay receipt exists, and the phone has no idea.
 *
 * This is an operator tool, not part of the app and not part of any test run. It lives beside the
 * test support because the architecture test already forbids production code from importing
 * anything here.
 *
 *   node apps/mobile/tests/support/dropping-proxy.mjs --target http://127.0.0.1:3000 --port 3001
 *
 * Then point the phone at the proxy instead of the server. Press "d" to arm, "q" to quit.
 *
 * `--arm-first` arms it at startup and drops the first creation without waiting for a keypress.
 * That is for driving it from a script, where there is no terminal to press a key in - and it is
 * what makes this tool something that can be checked rather than only trusted.
 */

import { createServer, request as httpRequest } from 'node:http';

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? fallback : process.argv[index + 1];
};

const target = new URL(argOf('target', 'http://127.0.0.1:3000'));
const port = Number(argOf('port', '3001'));
/** Which path's response to drop. Creation, unless you want to break something else. */
const dropPath = argOf('path', '/api/nodes/create');

let armed = process.argv.includes('--arm-first');
let dropped = 0;

const say = (text) => {
  process.stdout.write(`${text}\n`);
};

const proxy = createServer((clientRequest, clientResponse) => {
  const willDrop = armed && clientRequest.url === dropPath;

  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: clientRequest.url,
      method: clientRequest.method,
      headers: { ...clientRequest.headers, host: target.host },
    },
    (upstreamResponse) => {
      if (!willDrop) {
        clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(clientResponse);

        return;
      }

      // Drain the whole answer first. The server has committed by the time this completes, which is
      // the point: the creation is real and only the phone's knowledge of it is missing.
      upstreamResponse.resume();
      upstreamResponse.on('end', () => {
        armed = false;
        dropped += 1;
        say(`  dropped the answer to ${clientRequest.url} (${String(dropped)} so far)`);
        say('  the container exists on the server; the phone will say it cannot tell');
        clientRequest.socket.destroy();
      });
    },
  );

  upstream.on('error', (error) => {
    say(`  upstream error: ${error.message}`);
    if (!clientResponse.headersSent) clientResponse.writeHead(502);
    clientResponse.end();
  });

  clientRequest.pipe(upstream);
});

proxy.listen(port, '0.0.0.0', () => {
  say(`proxy  http://0.0.0.0:${String(port)}  ->  ${target.origin}`);
  say(`point the phone at this, not at ${target.origin}`);
  say('');
  if (armed) say('  armed at startup (--arm-first)');
  say('  d  arm: drop the answer to the next creation');
  say('  q  quit');
  say('');
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (keys) => {
    const key = keys.toString();

    if (key === 'd') {
      armed = true;
      say('  armed - the next creation will be committed and its answer thrown away');
    }

    // Ctrl-C arrives as a raw byte in this mode, so it is handled here rather than as a signal.
    if (key === 'q' || key === '') {
      proxy.close();
      process.exit(0);
    }
  });
}
