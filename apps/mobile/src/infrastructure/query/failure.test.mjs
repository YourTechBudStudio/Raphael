/**
 * What is worth trying again, and what a refusal means for the connection.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asClientFailure,
  isNotFound,
  ClientFailureError,
  connectionRejectionOf,
  MAX_RETRIES,
  shouldRetry,
  unwrap,
} from './failure.ts';

const failure = (overrides) => ({ kind: 'network', message: 'x', ...overrides });

test('a failed result throws with the failure intact, and a success is the value', () => {
  assert.equal(unwrap({ ok: true, value: 42 }), 42);

  try {
    unwrap({ ok: false, failure: failure({ message: 'the exchange failed' }) });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ClientFailureError);
    assert.equal(asClientFailure(error).kind, 'network');
    assert.equal(error.message, 'the exchange failed');
  }

  assert.equal(asClientFailure(new Error('something else')), null);
});

test('only the genuinely transient is retried', () => {
  for (const kind of ['network', 'timeout']) {
    assert.equal(shouldRetry(0, new ClientFailureError(failure({ kind }))), true, kind);
  }
  for (const kind of ['invalid_request', 'cancelled', 'bad_response']) {
    assert.equal(shouldRetry(0, new ClientFailureError(failure({ kind }))), false, kind);
  }

  const refused = failure({ kind: 'http', status: 401, code: 'unauthorized' });
  assert.equal(shouldRetry(0, new ClientFailureError(refused)), false);
  assert.equal(
    shouldRetry(0, new ClientFailureError(failure({ kind: 'http', status: 503 }))),
    true,
  );
});

test('retrying is bounded, and what is not a client failure is never retried', () => {
  const transient = new ClientFailureError(failure({ kind: 'timeout' }));

  assert.equal(shouldRetry(MAX_RETRIES - 1, transient), true);
  assert.equal(shouldRetry(MAX_RETRIES, transient), false);
  assert.equal(shouldRetry(0, new Error('a bug in our own code')), false);
});

test('only Raphael refusing the key counts as the connection being the problem', () => {
  const envelope = { kind: 'http', code: 'unauthorized' };
  assert.equal(connectionRejectionOf(failure({ ...envelope, status: 401 })), 'unauthorized');
  assert.equal(connectionRejectionOf(failure({ ...envelope, status: 403 })), 'unauthorized');
  assert.equal(
    connectionRejectionOf(failure({ kind: 'bad_response', code: 'incompatible_protocol' })),
    'incompatible_protocol',
  );

  // A proxy's own 401 page has no Raphael envelope, so it is not a refused key.
  assert.equal(connectionRejectionOf(failure({ kind: 'http', status: 401 })), null);
  assert.equal(connectionRejectionOf(failure({ kind: 'network' })), null);
  assert.equal(connectionRejectionOf(failure({ kind: 'http', status: 500 })), null);
});

test('only the server looking and finding nothing counts as gone', () => {
  assert.equal(isNotFound(failure({ kind: 'http', status: 404, code: 'node_not_found' })), true);
  assert.equal(isNotFound(failure({ kind: 'network' })), false);
  assert.equal(isNotFound(failure({ kind: 'http', status: 404 })), false);
});
