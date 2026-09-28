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
 * Acquisition and release. Ownership is observable from outside: the database is held exclusively, so
 * "was it released" is answered by trying to open it again.
 */

const isReleased = (file: string): boolean => {
  try {
    openDatabase({ databasePath: file, acquisitionTimeoutMs: 200 }).close();
    return true;
  } catch {
    return false;
  }
};

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

  test('a request that arrives during shutdown is answered 503, and shutdown finishes', async () => {
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
            drainMs: 2_000,
          }),
          scope,
        ),
      );

      // A raw socket, so the request can be mid-body when shutdown begins.
      const body = JSON.stringify({
        type: 'area',
        parent: { path: '/' },
        title: 'Halfway',
        slug: 'halfway',
      });
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

      assert.match(
        received,
        /^HTTP\/1\.1 503 /u,
        `expected an honest refusal, got: ${JSON.stringify(received.slice(0, 120))}`,
      );
      assert.match(received, /"code":"storage_busy"/u);
      assert.match(received, /"message":"The server is shutting down\. Try again\."/u);

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
        body: JSON.stringify({
          type: 'area',
          parent: { path: '/' },
          title: 'Committed',
          slug: 'committed',
        }),
      });
      assert.equal(created.status, 201);

      await Effect.runPromise(Scope.close(scope, Exit.void));

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
