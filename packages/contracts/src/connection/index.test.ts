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

/** A server one protocol revision behind, one ahead, and one predating the date-based scheme. */
const OLDER_DATE = '2026-09-10';
const NEWER_DATE = '2026-10-01';
const LEGACY_NUMERIC = 1;

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

test('the protocol version is a calendar date, and the current one is compatible with itself', () => {
  assert.match(PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(isCompatibleProtocolVersion(PROTOCOL_VERSION), true);

  const decoded = decodeVerifyResponse({ protocolVersion: PROTOCOL_VERSION });
  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.deepEqual(Object.keys(decoded.right), ['protocolVersion']);
    assert.equal(decoded.right.protocolVersion, PROTOCOL_VERSION);
  }
});

test('an identifier that is merely different decodes, so the mismatch can be explained', () => {
  // Three ways of being different, and all three must survive decoding: only a decoded identifier
  // can be named in a sentence about which side is behind.
  for (const version of [OLDER_DATE, NEWER_DATE, LEGACY_NUMERIC]) {
    const decoded = decodeVerifyResponse({ protocolVersion: version });
    assert.equal(Either.isRight(decoded), true, `${JSON.stringify(version)} must decode`);
    assert.equal(isCompatibleProtocolVersion(version), false);
  }
});

test('a mismatch names both identifiers and says which side to update', () => {
  for (const version of [OLDER_DATE, NEWER_DATE, LEGACY_NUMERIC]) {
    const message = describeProtocolMismatch(version);
    // Asserted in sentence position rather than as a bare pattern. A loose search would pass
    // vacuously for the legacy number, whose digit already appears inside the current date.
    assert.ok(message.includes(`speaks protocol ${version};`), message);
    assert.ok(message.includes(`understands ${PROTOCOL_VERSION}.`), message);
  }

  assert.match(describeProtocolMismatch(NEWER_DATE), /Update Raphael here\.$/u);
  assert.match(describeProtocolMismatch(OLDER_DATE), /Update the server\.$/u);
  // Every legacy number precedes the date-based scheme, so that server is behind whatever it says.
  assert.match(describeProtocolMismatch(LEGACY_NUMERIC), /Update the server\.$/u);
});

test('a mismatch is worded for a phone as readily as for a terminal', () => {
  for (const version of [OLDER_DATE, NEWER_DATE, LEGACY_NUMERIC]) {
    // "client" is jargon to someone holding the phone that is the client.
    assert.doesNotMatch(describeProtocolMismatch(version), /client/i);
  }
});

test('a malformed identifier fails decoding rather than becoming a mismatch', () => {
  // There is no honest sentence to say about any of these, so none of them reaches the mismatch
  // wording at all. An impossible calendar date is the case a bare pattern check would have missed.
  const malformed = ['2026-13-01', '2026-02-30', '2026-9-18', 'latest', '', 0, -1, 1.5, null, true];

  for (const protocolVersion of malformed) {
    assert.equal(
      Either.isLeft(decodeVerifyResponse({ protocolVersion })),
      true,
      `${JSON.stringify(protocolVersion)} must not decode`,
    );
  }

  assert.equal(Either.isLeft(decodeVerifyResponse({})), true);
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
