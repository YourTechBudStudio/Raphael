import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  classifyApiError,
  decodeApiErrorEnvelope,
  isApiErrorCode,
} from './errors.ts';

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
      ['idempotency_conflict', 409],
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
  assert.deepEqual(conflicts, [
    'slug_conflict',
    'idempotency_conflict',
    'revision_conflict',
    'node_archived',
  ]);
  // Two codes share 404 for genuinely different reasons: the address named no entity, or the server
  // publishes no operation there at all. A client that only saw the status could not tell them apart.
  const missing = API_ERROR_CODES.filter((code) => API_ERROR_STATUS[code] === 404);
  assert.deepEqual(missing, ['node_not_found', 'route_not_found']);
});

test('a known code classifies as known, with details preserved as data', () => {
  const envelope = {
    error: {
      code: 'slug_conflict',
      message: 'This parent already contains an entity with that slug.',
      details: { slug: 'backend', nested: { anything: [1, 'two'] } },
    },
  };
  const decoded = decodeApiErrorEnvelope(envelope);
  assert.equal(Either.isRight(decoded), true);
  if (!Either.isRight(decoded)) return;

  const classified = classifyApiError(decoded.right);
  assert.equal(classified.kind, 'known');
  assert.equal(classified.code, 'slug_conflict');
  assert.deepEqual(classified.details, envelope.error.details);
});

test('an unfamiliar code stays recognizable instead of becoming a guess or a success', () => {
  const decoded = decodeApiErrorEnvelope({
    error: { code: 'quota_exhausted', message: 'Later.', details: {} },
  });
  assert.equal(Either.isRight(decoded), true);
  if (!Either.isRight(decoded)) return;

  const classified = classifyApiError(decoded.right);
  assert.equal(classified.kind, 'unrecognized');
  assert.equal(classified.code, 'quota_exhausted');
  assert.equal(isApiErrorCode('quota_exhausted'), false);
});

test('details are always present, so no client has to handle two envelope shapes', () => {
  const decoded = decodeApiErrorEnvelope({
    error: {
      code: 'invalid_input',
      message: 'Add letters or numbers to the title.',
      details: { field: 'title', reason: 'slug_underivable' },
    },
  });
  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.deepEqual(classifyApiError(decoded.right).details, {
      field: 'title',
      reason: 'slug_underivable',
    });
  }
});

test('a malformed envelope is an invalid response, not an unrecognized error', () => {
  for (const payload of [
    {},
    { error: {} },
    { error: { code: 'invalid_input' } },
    { error: { code: 'invalid_input', message: 'x' } },
    { error: { code: 7, message: 'x', details: {} } },
    { error: { code: 'invalid_input', message: 'x', details: [1] } },
    { error: { code: 'invalid_input', message: 'x', details: null } },
    'unauthorized',
  ]) {
    assert.equal(Either.isLeft(decodeApiErrorEnvelope(payload)), true, JSON.stringify(payload));
  }
});

test('an envelope tolerates an added property like any other response', () => {
  const decoded = decodeApiErrorEnvelope({
    error: { code: 'internal_error', message: 'x', details: {}, traceId: 'abc' },
  });
  assert.equal(Either.isRight(decoded), true);
});
