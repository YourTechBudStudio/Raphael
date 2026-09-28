import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import { API_ERROR_CODES, API_ERROR_STATUS, decodeApiErrorEnvelope } from './errors.ts';

test('every code has a status, and the catalog has no extras', () => {
  assert.deepEqual(Object.keys(API_ERROR_STATUS).sort(), [...API_ERROR_CODES].sort());
  assert.deepEqual(
    API_ERROR_CODES.map((code) => [code, API_ERROR_STATUS[code]]),
    [
      ['invalid_input', 400],
      ['unauthorized', 401],
      ['node_not_found', 404],
      ['route_not_found', 404],
      ['method_not_allowed', 405],
      ['slug_conflict', 409],
      ['revision_conflict', 409],
      ['node_archived', 409],
      ['payload_too_large', 413],
      ['unsupported_media_type', 415],
      ['invalid_parent', 422],
      ['unsupported_content', 422],
      ['storage_busy', 503],
      ['internal_error', 500],
    ],
  );
});

test('statuses are not reversible, which is why the mapping is one-directional', () => {
  const conflicts = API_ERROR_CODES.filter((code) => API_ERROR_STATUS[code] === 409);
  assert.deepEqual(conflicts, ['slug_conflict', 'revision_conflict', 'node_archived']);
  // Two codes share 404 for genuinely different reasons: the address named no entity, or the server
  // publishes no operation there at all. A client that only saw the status could not tell them apart.
  const missing = API_ERROR_CODES.filter((code) => API_ERROR_STATUS[code] === 404);
  assert.deepEqual(missing, ['node_not_found', 'route_not_found']);
});

test('an envelope is a code and a message, and an unfamiliar code still decodes', () => {
  const decoded = decodeApiErrorEnvelope({
    error: { code: 'quota_exhausted', message: 'Later.' },
  });
  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.deepEqual(decoded.right, { error: { code: 'quota_exhausted', message: 'Later.' } });
  }
});

test('a malformed envelope does not decode', () => {
  for (const payload of [
    {},
    { error: {} },
    { error: { code: 'invalid_input' } },
    { error: { code: 7, message: 'x' } },
    { error: { code: 'invalid_input', message: 7 } },
    'unauthorized',
  ]) {
    assert.equal(Either.isLeft(decodeApiErrorEnvelope(payload)), true, JSON.stringify(payload));
  }
});

test('an envelope tolerates an added property like any other response', () => {
  const decoded = decodeApiErrorEnvelope({
    error: { code: 'internal_error', message: 'x', traceId: 'abc' },
  });
  assert.equal(Either.isRight(decoded), true);
});
