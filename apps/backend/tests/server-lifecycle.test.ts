import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, test } from 'node:test';

import { Effect, Exit, Scope } from 'effect';

import { ApiCredential } from '../src/infrastructure/config/credential.ts';
import { openDatabase } from '../src/infrastructure/database/connection.ts';
import { recordingLogger, silentLogger } from '../src/infrastructure/http/log.ts';
import { serve } from '../src/server.ts';
import { call, testKey, testOptions, withServer } from './server-support.ts';
import { tempDatabase } from './support.ts';

/**
 * Acquisition, release, and the deadlines.
 *
 * Ownership is observable from outside the process: the database is held exclusively, so "was it
 * released" is answered by trying to open it again rather than by inspecting our own state.
 *
 * The deadline tests inject short durations and assert generously. What they establish is that a
 * connection is actually destroyed rather than that it is destroyed at a precise moment - a
 * same-thread timer fires when the event loop reaches it, so the observed delay is the configured
 * duration plus scheduling, never less but not exactly equal either.
 */

const isReleased = (file: string): boolean => {
  try {
    openDatabase({ databasePath: file, acquisitionTimeoutMs: 200 }).close();
    return true;
  } catch {
    return false;
  }
};

/** Open a raw socket and keep it open. Used to test what happens to a connection that does nothing. */
const rawSocket = (
  host: string,
  port: number,
  payload?: string,
): Promise<{ closedAfterMs: () => Promise<number> }> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, host, () => {
      const openedAt = Date.now();
      if (payload !== undefined) socket.write(payload);
      resolve({
        closedAfterMs: () =>
          new Promise<number>((settle) => {
            if (socket.destroyed) {
              settle(Date.now() - openedAt);
              return;
            }
            socket.once('close', () => settle(Date.now() - openedAt));
            socket.once('error', () => settle(Date.now() - openedAt));
          }),
      });
    });
    socket.once('error', reject);
  });

describe('acquisition', () => {
  test('port 0 binds and reports the port actually chosen', async () => {
    await withServer('lifecycle-port', async (server) => {
      assert.ok(server.port > 0, 'an ephemeral port must be reported back');
      const response = await call(server, '/api/connection/verify', { body: '{}' });
      assert.equal(response.status, 200);
    });
  });

  test('migrations complete before the listener accepts anything', async () => {
    await withServer('lifecycle-migrated', async (server) => {
      // The very first request a server can possibly receive already sees the migrated schema,
      // including the seeded root areas. There is no window in which the listener is open and the
      // schema is not current.
      const list = await call(server, '/api/nodes/list', { body: '{"scopes":[{"path":"/"}]}' });
      assert.equal(list.status, 200);
      assert.equal((list.json as { items: unknown[] }).items.length, 2);
    });
  });

  test('a failure during acquisition releases everything it already took', async () => {
    const temp = tempDatabase('lifecycle-acquire-fail');
    const holder = openDatabase({ databasePath: temp.file });
    try {
      // The listener cannot be acquired because the database is already owned by `holder`, so
      // startup fails at the first resource.
      const scope = Effect.runSync(Scope.make());
      const outcome = await Effect.runPromiseExit(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(testKey()),
            logger: silentLogger,
          }),
          scope,
        ),
      );
      assert.equal(outcome._tag, 'Failure');
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      holder.close();
      temp.cleanup();
    }
  });

  test('an unbindable port fails startup and leaves the database released', async () => {
    const temp = tempDatabase('lifecycle-port-fail');
    const blocker = await withServer('lifecycle-blocker', async (server) => server.port, {});
    try {
      const scope = Effect.runSync(Scope.make());
      const outcome = await Effect.runPromiseExit(
        Scope.extend(
          serve({
            // Port 1 is privileged and cannot be bound by an ordinary user.
            options: testOptions(temp.file, { port: 1 }),
            credential: ApiCredential.fromKey(testKey()),
            logger: silentLogger,
          }),
          scope,
        ),
      );
      assert.equal(outcome._tag, 'Failure');
      await Effect.runPromise(Scope.close(scope, Exit.void));
      assert.ok(
        isReleased(temp.file),
        'a listener that could not bind must not leave the database owned',
      );
      assert.ok(blocker > 0);
    } finally {
      temp.cleanup();
    }
  });
});

describe('release', () => {
  test('closing the scope stops the listener and releases the database', async () => {
    const temp = tempDatabase('lifecycle-release');
    const key = testKey();
    const scope = Effect.runSync(Scope.make());
    try {
      const running = await Effect.runPromise(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(key),
            logger: silentLogger,
          }),
          scope,
        ),
      );
      assert.equal(
        (await call({ ...running, key }, '/api/connection/verify', { body: '{}' })).status,
        200,
      );

      await Effect.runPromise(Scope.close(scope, Exit.void));

      assert.ok(isReleased(temp.file), 'the database must be released with the scope');
      await assert.rejects(
        () => call({ ...running, key }, '/api/connection/verify', { body: '{}' }),
        'the listener must be closed',
      );
    } finally {
      temp.cleanup();
    }
  });

  test('a connection mid-request is not reset at shutdown; it is answered honestly', async () => {
    const temp = tempDatabase('lifecycle-drain');
    const key = testKey();
    const logger = recordingLogger();
    const scope = Effect.runSync(Scope.make());
    try {
      const running = await Effect.runPromise(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(key),
            logger,
            deadlines: { drainMs: 2_000 },
          }),
          scope,
        ),
      );

      // A raw socket, because this needs a request the server has genuinely begun receiving and has
      // not finished. `fetch` cannot express that, and a request merely *written* before shutdown is
      // still on the network - the server never received it, so a reset is the only honest answer and
      // there is nothing here to test.
      const body = JSON.stringify({ type: 'area', parent: { path: '/' }, title: 'Halfway' });
      const socket = connect(running.port, running.host);
      await new Promise((ready) => socket.once('connect', ready));

      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
      });
      socket.on('error', () => {});
      const finished = new Promise<void>((resolve) => socket.once('close', () => resolve()));

      // Headers and part of the body. The server is now mid-request.
      socket.write(
        `POST /api/nodes/create HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${key}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
          body.slice(0, 10),
      );
      await new Promise((settled) => setTimeout(settled, 100));

      const closing = Effect.runPromise(Scope.close(scope, Exit.void));
      await new Promise((settled) => setTimeout(settled, 100));
      socket.write(body.slice(10));

      await finished;
      await closing;

      // Not a reset: the connection survived the close of quiet connections because it was mid-
      // request, and the caller got a real answer.
      assert.match(
        received,
        /^HTTP\/1\.1 503 /u,
        `expected an honest refusal, got: ${JSON.stringify(received.slice(0, 120))}`,
      );
      assert.match(received, /"code":"storage_busy"/u);
      assert.match(received, /"reason":"shutting_down"/u);

      // Refused means refused: nothing was written.
      assert.ok(isReleased(temp.file));
      const reopened = openDatabase({ databasePath: temp.file });
      try {
        assert.equal(
          reopened.db.prepare("SELECT slug FROM nodes WHERE slug = 'halfway'").all().length,
          0,
        );
      } finally {
        reopened.close();
      }

      assert.deepEqual(
        logger.lines.filter((line) => line.event.startsWith('server.')).map((line) => line.event),
        ['server.listening', 'server.stopping', 'server.stopped'],
      );
    } finally {
      temp.cleanup();
    }
  });

  test('a request answered before shutdown is committed, and storage closes after', async () => {
    const temp = tempDatabase('lifecycle-committed');
    const key = testKey();
    const scope = Effect.runSync(Scope.make());
    try {
      const running = await Effect.runPromise(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(key),
            logger: silentLogger,
          }),
          scope,
        ),
      );
      const created = await call({ ...running, key }, '/api/nodes/create', {
        body: JSON.stringify({ type: 'area', parent: { path: '/' }, title: 'Committed' }),
      });
      assert.equal(created.status, 201);

      await Effect.runPromise(Scope.close(scope, Exit.void));

      // The write survives the shutdown, which is the part a caller depends on: a 201 is a fact about
      // storage, not about a response that happened to be written.
      const reopened = openDatabase({ databasePath: temp.file });
      try {
        assert.equal(
          reopened.db.prepare("SELECT slug FROM nodes WHERE slug = 'committed'").all().length,
          1,
        );
      } finally {
        reopened.close();
      }
    } finally {
      temp.cleanup();
    }
  });
});

describe('derived-text maintenance', () => {
  test('runs at startup, fills the seeded projections, and never gates the listener', async () => {
    const temp = tempDatabase('lifecycle-backfill');
    const key = testKey();
    const logger = recordingLogger();
    const scope = Effect.runSync(Scope.make());
    try {
      const running = await Effect.runPromise(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(key),
            logger,
          }),
          scope,
        ),
      );

      // The listener answers straight away. The pass is forked, never awaited: a cold start must
      // accept requests while it works, not afterwards.
      assert.equal(
        (await call({ ...running, key }, '/api/connection/verify', { body: '{}' })).status,
        200,
      );

      // Give the forked pass its turn. It is bounded and tiny here, so a few macrotasks is plenty.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));

      await Effect.runPromise(Scope.close(scope, Exit.void));

      // Observed through storage after release, which is the only honest place to look: if the pass
      // were still running when the database was released, this read could not succeed at all.
      const reopened = openDatabase({ databasePath: temp.file, acquisitionTimeoutMs: 200 });
      try {
        const remaining = reopened.db
          .prepare('SELECT count(*) AS c FROM nodes WHERE body_text IS NULL')
          .get() as { c: number };
        assert.equal(remaining.c, 0, 'the seeded rows have their projection');
      } finally {
        reopened.close();
      }

      const skipped = logger.lines.filter((line) => line.event === 'nodes.derived_text_skipped');
      assert.deepEqual(skipped, [], 'nothing in a fresh database is unreadable');
    } finally {
      temp.cleanup();
    }
  });

  test('maintenance is interrupted and awaited before the database is released', async () => {
    const temp = tempDatabase('lifecycle-backfill-release');
    const key = testKey();
    const scope = Effect.runSync(Scope.make());
    try {
      await Effect.runPromise(
        Scope.extend(
          serve({
            options: testOptions(temp.file),
            credential: ApiCredential.fromKey(key),
            logger: silentLogger,
          }),
          scope,
        ),
      );

      // Closed immediately, with the pass very likely still in flight. Releasing storage beneath a
      // running write transaction is the failure this ordering exists to prevent, and it would show
      // up here as the release throwing or the database staying locked.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      assert.ok(isReleased(temp.file), 'maintenance must be stopped before storage is released');
    } finally {
      temp.cleanup();
    }
  });
});

describe('deadlines', () => {
  test('a connection that never sends a byte is destroyed', async () => {
    await withServer(
      'deadline-silent',
      async (server) => {
        const socket = await rawSocket(server.host, server.port);
        const closedAfter = await socket.closedAfterMs();
        assert.ok(closedAfter >= 100, `closed after ${closedAfter}ms, before its deadline`);
        assert.ok(closedAfter < 8_000, `closed after ${closedAfter}ms, which is not bounded`);
      },
      { deadlines: { headersMs: 150, requestMs: 300, checkIntervalMs: 50 } },
    );
  });

  test('a request that stalls part-way through its headers is destroyed', async () => {
    await withServer(
      'deadline-partial-headers',
      async (server) => {
        const socket = await rawSocket(
          server.host,
          server.port,
          'POST /api/nodes/get HTTP/1.1\r\nHost: x\r\n',
        );
        const closedAfter = await socket.closedAfterMs();
        assert.ok(closedAfter < 8_000, `closed after ${closedAfter}ms, which is not bounded`);
      },
      { deadlines: { headersMs: 150, requestMs: 300, checkIntervalMs: 50 } },
    );
  });

  test('an authenticated upload that stalls mid-body is destroyed', async () => {
    await withServer(
      'deadline-stalled-body',
      async (server) => {
        // Complete headers with a credential, a declared body, and then silence. This is the case
        // Node's own `requestTimeout` did not bound on this version, which is why the server arms its
        // own receive deadline.
        const socket = await rawSocket(
          server.host,
          server.port,
          `POST /api/nodes/create HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${server.key}\r\n` +
            `Content-Type: application/json\r\nContent-Length: 200\r\n\r\n{"partial":`,
        );
        const closedAfter = await socket.closedAfterMs();
        assert.ok(closedAfter < 8_000, `closed after ${closedAfter}ms, which is not bounded`);
      },
      { deadlines: { headersMs: 2_000, requestMs: 200, checkIntervalMs: 50 } },
    );
  });

  test('a short receive deadline never cuts an ordinary request short', async () => {
    await withServer(
      'deadline-normal-request',
      async (server) => {
        // The receive deadline is cleared when the body has arrived, so it can never interrupt the
        // handling that follows. A deadline that bounded handling would be a claim this server cannot
        // make: the operation below is synchronous and not interruptible.
        const created = await call(server, '/api/nodes/create', {
          body: JSON.stringify({ type: 'area', parent: { path: '/' }, title: 'Unhurried' }),
        });
        assert.equal(created.status, 201);
      },
      { deadlines: { headersMs: 300, requestMs: 300, checkIntervalMs: 50 } },
    );
  });

  test('an idle keep-alive connection does not stop the server answering', async () => {
    await withServer(
      'deadline-keepalive',
      async (server) => {
        assert.equal((await call(server, '/api/connection/verify', { body: '{}' })).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal((await call(server, '/api/connection/verify', { body: '{}' })).status, 200);
      },
      { deadlines: { keepAliveMs: 100, checkIntervalMs: 50 } },
    );
  });
});
