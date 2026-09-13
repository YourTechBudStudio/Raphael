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

const failure = (overrides) => ({
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: 'x',
  ...overrides,
});

test('a failed result throws with the failure intact, and a success is the value', () => {
  assert.equal(unwrap({ ok: true, value: 42 }), 42);

  try {
    unwrap({ ok: false, failure: failure({ message: 'the exchange failed' }) });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ClientFailureError);
    assert.equal(asClientFailure(error).kind, 'transport');
    assert.equal(error.message, 'the exchange failed');
  }

  assert.equal(asClientFailure(new Error('something else')), null);
});

test('only the genuinely transient is retried', () => {
  const retried = ['transport', 'timeout'];
  const settled = ['invalid_request', 'cancelled', 'unsupported_fetch'];

  for (const kind of retried) {
    assert.equal(shouldRetry(0, new ClientFailureError(failure({ kind }))), true, kind);
  }

  for (const kind of settled) {
    assert.equal(shouldRetry(0, new ClientFailureError(failure({ kind }))), false, kind);
  }

  // A refused key is an answer, not bad luck. Retrying it turns one rejection into a burst.
  const refused = new ClientFailureError(failure({ kind: 'api_error', status: 401 }));
  assert.equal(shouldRetry(0, refused), false);
  // A server having a bad moment is different from a server having an opinion.
  assert.equal(
    shouldRetry(0, new ClientFailureError(failure({ kind: 'api_error', status: 503 }))),
    true,
  );
  // A protocol mismatch will not resolve itself either.
  assert.equal(
    shouldRetry(
      0,
      new ClientFailureError(
        failure({ kind: 'invalid_response', reason: 'incompatible_protocol' }),
      ),
    ),
    false,
  );
});

test('retrying is bounded, and what is not a client failure is never retried', () => {
  const transient = new ClientFailureError(failure({ kind: 'timeout' }));

  assert.equal(shouldRetry(MAX_RETRIES - 1, transient), true);
  assert.equal(shouldRetry(MAX_RETRIES, transient), false);
  assert.equal(shouldRetry(0, new Error('a bug in our own code')), false);
});

test('only Raphael refusing the key counts as the connection being the problem', () => {
  assert.equal(connectionRejectionOf(failure({ kind: 'api_error', status: 401 })), 'unauthorized');
  assert.equal(connectionRejectionOf(failure({ kind: 'api_error', status: 403 })), 'unauthorized');
  assert.equal(
    connectionRejectionOf(failure({ kind: 'invalid_response', reason: 'incompatible_protocol' })),
    'incompatible_protocol',
  );

  // A proxy in front of the server answering 401 with a page of HTML is not Raphael refusing a
  // key - the client reads it as an unintelligible answer, and it must not be reported as one.
  assert.equal(
    connectionRejectionOf(failure({ kind: 'invalid_response', reason: 'unrecognized_error' })),
    null,
  );
  assert.equal(connectionRejectionOf(failure({ kind: 'transport' })), null);
  assert.equal(connectionRejectionOf(failure({ kind: 'api_error', status: 500 })), null);
});

test('only the server looking and finding nothing counts as gone', () => {
  assert.equal(isNotFound(failure({ kind: 'api_error', status: 404 })), true);

  // A read that could not be made says nothing about whether the container exists, and a 404 page
  // from a proxy is not Raphael answering. Treating either as "gone" would tell someone their area
  // was deleted because their wifi dropped.
  assert.equal(isNotFound(failure({ kind: 'transport' })), false);
  assert.equal(isNotFound(failure({ kind: 'timeout' })), false);
  assert.equal(
    isNotFound(failure({ kind: 'invalid_response', reason: 'unrecognized_error', status: 404 })),
    false,
  );
});
