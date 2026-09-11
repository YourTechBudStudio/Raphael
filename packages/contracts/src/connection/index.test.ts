import assert from 'node:assert/strict';
import test from 'node:test';

import { Either } from 'effect';

import {
  CONNECTION_ROUTES,
  PROTOCOL_VERSION,
  decodeVerifyRequest,
  decodeVerifyResponse,
  describeProtocolMismatch,
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
