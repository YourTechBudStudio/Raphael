import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  CONNECTION_ROUTES,
  PROTOCOL_VERSION,
  decodeVerifyRequest,
  decodeVerifyResponse,
  describeProtocolMismatch,
  hasApiKey,
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
  assert.match(describeProtocolMismatch(PROTOCOL_VERSION + 1), /Update Raphael here\./);
  assert.match(describeProtocolMismatch(PROTOCOL_VERSION - 1), /Update the server\./);
});

test('a mismatch is worded for a phone as readily as for a terminal', () => {
  for (const version of [PROTOCOL_VERSION + 1, PROTOCOL_VERSION - 1]) {
    // "client" is jargon to someone holding the phone that is the client.
    assert.doesNotMatch(describeProtocolMismatch(version), /client/i);
  }
});

/**
 * The key policy, which is that there isn't one.
 *
 * A key is whatever the owner started their server with. These assertions exist to keep a shape
 * rule from creeping back in: a floor added here would silently lock an owner out of their own
 * server after their key had been working.
 */

test('a key is whatever the owner chose, of any length or alphabet', () => {
  const keys = [
    'a',
    '0123456789abcdef0123456789abcdef',
    'dGhpcy1pcy1hLXRlc3Qta2V5LXZhbHVlLTEyMw',
    'dGhpcyBpcyBhIHRlc3Qga2V5IHZhbHVlIQ==',
    '!#$%&()*+,-./:;<=>?@[]^_`{|}~0123456789',
    'a key with spaces',
    'ключ',
    '🔑🔑🔑',
    'trailing-newline\n',
  ];
  for (const key of keys) {
    assert.equal(hasApiKey(key), true, JSON.stringify(key));
  }
});

test('only the absence of a key is refused', () => {
  assert.equal(hasApiKey(''), false);
});

test('a key is never trimmed or re-encoded on its way through', () => {
  // Raphael compares what it was given. Quietly trimming a trailing space would make a key that
  // works here fail against a server that kept the space, which is worse than either behaviour
  // applied consistently.
  const padded = '  spaced key  ';
  assert.equal(hasApiKey(padded), true);
  assert.equal(padded.trim() === padded, false);
});
