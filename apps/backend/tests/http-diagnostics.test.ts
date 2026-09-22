import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiCredential } from '../src/infrastructure/config/credential.ts';
import { authenticate, authorizationFields } from '../src/infrastructure/http/auth.ts';
import { UNMATCHED_ROUTE, methodLabel } from '../src/infrastructure/http/log.ts';
import { call, testKey, withServer } from './server-support.ts';

/**
 * What the server says about itself, and to whom.
 *
 * Two separate obligations. A *caller* learns the outcome of their request and nothing about the
 * server's internals. An *operator* gets enough to find a bug without the log becoming a place where
 * note content, credentials, or caller-controlled text accumulate.
 */

describe('what a caller is told', () => {
  test('no response carries a path, a header, a credential, or a stack', async () => {
    await withServer('diag-responses', async (server) => {
      const responses = [
        await call(server, '/api/nodes/get', { body: '{"target":{"id":999999}}' }),
        await call(server, '/api/nodes/get', { body: 'not json' }),
        await call(server, '/api/secret-internal-thing', { body: '{}' }),
        await call(server, '/api/nodes/get', { method: 'GET' }),
        await call(server, '/api/connection/verify', { body: '{}', authorize: false }),
      ];

      for (const response of responses) {
        if (response.text.length === 0) continue;
        assert.equal(response.text.includes(server.key), false, 'a response carried the key');
        assert.equal(response.text.includes(server.temp.file), false, 'a response carried a path');
        assert.equal(response.text.includes('secret-internal-thing'), false);
        assert.equal(/\bat [A-Za-z]+ \(/u.test(response.text), false, 'a response carried a stack');
        assert.equal(/node:internal|SQLITE_|better-sqlite3/u.test(response.text), false);
      }
    });
  });

  test('an error envelope has exactly the published shape', async () => {
    await withServer('diag-envelope', async (server) => {
      const response = await call(server, '/api/nodes/get', { body: '{"target":{"id":999999}}' });
      assert.deepEqual(Object.keys(response.json as object), ['error']);
      const error = (response.json as { error: Record<string, unknown> }).error;
      // `details` is always present, `{}` when there is nothing structured to say, so a client never
      // has to handle two shapes.
      assert.deepEqual(Object.keys(error).sort(), ['code', 'details', 'message']);
    });
  });

  test('a verification response reports the protocol and nothing about the installation', async () => {
    await withServer('diag-verify', async (server) => {
      const response = await call(server, '/api/connection/verify', { body: '{}' });
      assert.deepEqual(Object.keys(response.json as object), ['protocolVersion']);
      assert.equal(response.text.includes(server.temp.dir), false);
    });
  });
});

describe('what an operator is told', () => {
  test('ordinary traffic writes no log line at all', async () => {
    await withServer('diag-quiet', async (server) => {
      await call(server, '/api/connection/verify', { body: '{}' });
      await call(server, '/api/nodes/list', { body: '{"scopes":[{"path":"/"}]}' });
      await call(server, '/api/nodes/get', { body: '{"target":{"id":999999}}' });
      await call(server, '/api/nodes/get', { body: 'not json' });
      await call(server, '/api/connection/verify', { body: '{}', authorize: false });

      const requestLines = server.logger.lines.filter((line) => line.event.startsWith('request.'));
      // Expected outcomes - a missing node, bad JSON, a refused credential - are answered, not logged.
      // A line per request would be an access log assembled one failure at a time.
      assert.deepEqual(requestLines, []);
    });
  });

  test('startup names the bound address, and never the credential', async () => {
    await withServer('diag-startup', async (server) => {
      const listening = server.logger.lines.find((line) => line.event === 'server.listening');
      assert.ok(listening !== undefined);
      assert.deepEqual(Object.keys(listening.fields).sort(), ['databasePath', 'host', 'port']);
      const rendered = JSON.stringify(server.logger.lines);
      assert.equal(rendered.includes(server.key), false);
    });
  });

  test('a route is logged by its own label, never by the requested path', () => {
    // A path is caller-controlled text and can carry a credential exactly as a body can. The label is
    // our word for a route we published; an unmatched request is one fixed word.
    assert.equal(UNMATCHED_ROUTE, 'unmatched');
    assert.equal(methodLabel('POST'), 'POST');
    assert.equal(methodLabel('PROPFIND'), 'other');
    assert.equal(methodLabel(undefined), 'other');
    assert.equal(methodLabel('POST\n injected=1'), 'other');
  });
});

describe('credential comparison', () => {
  const credential = ApiCredential.fromKey(testKey());

  test('two fields are ambiguous, and one in a list is just that one', () => {
    // The array here is what `authorizationFields` produces from `rawHeaders`, not a shape Node hands
    // us: Node keeps one repeated `Authorization` and discards the rest. An earlier version of this
    // test asserted against an array Node never delivers, so it passed while the HTTP path accepted a
    // duplicated credential. The behavior on the wire is pinned in `http-boundary.test.ts`.
    assert.deepEqual(authenticate([`Bearer ${testKey()}`, 'Bearer other'], credential), {
      ok: false,
      reason: 'ambiguous',
    });
    assert.deepEqual(authenticate([], credential), { ok: false, reason: 'missing' });
    assert.equal(authenticate([`Bearer ${testKey()}`], credential).ok, true);
  });

  test('authorization fields are read from the raw header list, folding name case', () => {
    assert.deepEqual(
      authorizationFields([
        'Host',
        'x',
        'Authorization',
        'Bearer one',
        'Content-Type',
        'application/json',
        'authorization',
        'Bearer two',
      ]),
      ['Bearer one', 'Bearer two'],
    );
    assert.deepEqual(authorizationFields(['Host', 'x']), []);
    // A malformed odd-length list never reads past the end.
    assert.deepEqual(authorizationFields(['Authorization']), []);
  });

  test('the token is taken verbatim, with no trimming or unquoting', () => {
    assert.equal(authenticate(`Bearer ${testKey()} `, credential).ok, false);
    assert.equal(authenticate(`Bearer "${testKey()}"`, credential).ok, false);
    assert.equal(authenticate(`Bearer  ${testKey()}`, credential).ok, false);
    assert.equal(authenticate(`Bearer ${testKey()}`, credential).ok, true);
  });

  test('a missing header and a wrong key are distinguishable to us and not to the caller', () => {
    // Operator-facing reasons differ; both become the same `unauthorized` envelope at the boundary,
    // which is what the HTTP tests pin.
    assert.equal(authenticate(undefined, credential).ok, false);
    assert.notEqual(
      (authenticate(undefined, credential) as { reason: string }).reason,
      (authenticate('Bearer wrong-but-long-enough-key-value', credential) as { reason: string })
        .reason,
    );
  });
});
