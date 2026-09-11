import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  API_KEY_MIN_LENGTH,
  CONNECTION_ROUTES,
  PROTOCOL_VERSION,
  decodeVerifyRequest,
  decodeVerifyResponse,
  describeProtocolMismatch,
  inspectApiKey,
  isCompatibleProtocolVersion,
} from './index.ts';

test('verification is published where the clients expect it', () => {
  assert.deepEqual(CONNECTION_ROUTES, {
    verify: { method: 'POST', path: '/api/connection/verify' },
  });
});

test('verification carries no input, and an unknown property is refused', () => {
  assert.equal(Either.isRight(decodeVerifyRequest({})), true);
  assert.equal(Either.isLeft(decodeVerifyRequest({ key: 'secret' })), true);
  assert.equal(Either.isLeft(decodeVerifyRequest(undefined)), true);
});

test('a value that is merely key-less is not an empty object', () => {
  // An empty struct has no declared field to compare against, so on its own it accepts a number, an
  // array, or any object with no own enumerable keys. Each of these decoded as a valid request until
  // the shape was checked explicitly.
  for (const value of [42, [], new Date(), null, 'text', true]) {
    assert.equal(
      Either.isLeft(decodeVerifyRequest(value)),
      true,
      `${JSON.stringify(value)} must not decode as a verification request`,
    );
  }
});

test('the response reports a protocol version and nothing about the server', () => {
  const decoded = decodeVerifyResponse({ protocolVersion: PROTOCOL_VERSION });
  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.deepEqual(Object.keys(decoded.right), ['protocolVersion']);
  }
  assert.equal(Either.isLeft(decodeVerifyResponse({ protocolVersion: 0 })), true);
  assert.equal(Either.isLeft(decodeVerifyResponse({ protocolVersion: '1' })), true);
  assert.equal(Either.isLeft(decodeVerifyResponse({})), true);
});

test('an incompatible version decodes, so the mismatch can be explained', () => {
  const decoded = decodeVerifyResponse({ protocolVersion: PROTOCOL_VERSION + 1 });
  assert.equal(Either.isRight(decoded), true);
  assert.equal(isCompatibleProtocolVersion(PROTOCOL_VERSION), true);
  assert.equal(isCompatibleProtocolVersion(PROTOCOL_VERSION + 1), false);
  assert.match(describeProtocolMismatch(PROTOCOL_VERSION + 1), /Update the client\./);
  assert.match(describeProtocolMismatch(PROTOCOL_VERSION - 1), /Update the server\./);
});

/**
 * The key policy. It lives here rather than in the server because the server, the login command, and
 * mobile setup all have to apply exactly the same rule - a key the CLI is willing to save but the
 * server will not start with is a setup that fails after the person thought it succeeded.
 */

test('a usable key is accepted in every shape a generator produces', () => {
  const shapes = [
    'a'.repeat(API_KEY_MIN_LENGTH),
    '0123456789abcdef0123456789abcdef', // hex
    'dGhpcy1pcy1hLXRlc3Qta2V5LXZhbHVlLTEyMw', // base64url
    'dGhpcyBpcyBhIHRlc3Qga2V5IHZhbHVlIQ==', // base64 with padding
    '!#$%&()*+,-./:;<=>?@[]^_`{|}~0123456789', // the full visible-ASCII range
  ];
  for (const key of shapes) {
    assert.equal(inspectApiKey(key), undefined, `${key.slice(0, 8)}... should be usable`);
  }
});

test('an empty key is distinguished from a short one', () => {
  assert.deepEqual(inspectApiKey(''), { reason: 'empty' });
  assert.deepEqual(inspectApiKey('a'.repeat(API_KEY_MIN_LENGTH - 1)), {
    reason: 'too_short',
    limit: API_KEY_MIN_LENGTH,
  });
});

test('a key that could never travel in a header is refused before length is considered', () => {
  // Measured in phase 05: a non-ASCII key is hashed from its UTF-8 string, arrives as those bytes
  // reinterpreted one-per-character, and never matches - and `fetch` refuses to send it at all. Both
  // of these are long enough to pass the floor, so character rejection has to come first or they
  // would start a server that no client could ever authenticate against.
  for (const key of ['é'.repeat(API_KEY_MIN_LENGTH), '🔑'.repeat(API_KEY_MIN_LENGTH)]) {
    assert.deepEqual(inspectApiKey(key), { reason: 'unusable_characters' });
  }
});

test('whitespace and control characters are refused rather than trimmed', () => {
  const base = 'a'.repeat(API_KEY_MIN_LENGTH);
  for (const key of [` ${base}`, `${base} `, `${base}\n`, `${base}\u0000`, `${base}\t`]) {
    assert.deepEqual(inspectApiKey(key), { reason: 'unusable_characters' });
  }
});

test('the rejection never carries the key it rejected', () => {
  const secret = 'super-secret-value-that-is-long-enough-\u0000';
  const rejection = inspectApiKey(secret);
  assert.notEqual(rejection, undefined);
  assert.equal(JSON.stringify(rejection).includes('super-secret'), false);
});
