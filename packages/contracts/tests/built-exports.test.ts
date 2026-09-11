import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Either } from 'effect';

/**
 * Exercises the package through its published entry points rather than its sources, so a passing
 * source test cannot hide a missing export, a wrong exports path, or absent declarations. Run after
 * `pnpm build`, which is the order `pnpm check` uses.
 */
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

test('the package is built before its public surface is exercised', () => {
  assert.ok(existsSync(dist), 'dist/ is missing: run `pnpm build` first');
});

test('every capability entry point resolves with its declarations', async () => {
  for (const file of [
    'index.js',
    'index.d.ts',
    'nodes/index.js',
    'nodes/index.d.ts',
    'connection/index.js',
    'connection/index.d.ts',
  ]) {
    assert.ok(existsSync(new URL(file, new URL('../dist/', import.meta.url))), file);
  }
});

test('the shared root exposes the error envelope and decoding policies', async () => {
  const contracts = await import('@raphael/contracts');
  assert.equal(contracts.API_ERROR_STATUS.slug_conflict, 409);
  assert.equal(typeof contracts.requestDecoder, 'function');
  assert.equal(typeof contracts.responseDecoder, 'function');

  const decoded = contracts.decodeApiErrorEnvelope({
    error: { code: 'node_not_found', message: 'Gone.', details: {} },
  });
  assert.equal(Either.isRight(decoded), true);
  if (Either.isRight(decoded)) {
    assert.equal(contracts.classifyApiError(decoded.right).kind, 'known');
  }
});

test('the root does not re-export capability vocabulary', async () => {
  const contracts: Record<string, unknown> = await import('@raphael/contracts');
  for (const name of ['CreateRequest', 'NODE_ROUTES', 'deriveSlug', 'PROTOCOL_VERSION']) {
    assert.equal(name in contracts, false, name);
  }
});

test('the nodes entry point decodes a request and a response', async () => {
  const nodes = await import('@raphael/contracts/nodes');
  assert.equal(nodes.NODE_ROUTES.create.path, '/api/nodes/create');
  assert.equal(
    Either.isRight(
      nodes.decodeCreateRequest({ type: 'area', parent: { path: '/' }, title: 'Backend' }),
    ),
    true,
  );
  assert.equal(Either.getOrUndefined(nodes.deriveSlug('Backend Work')), 'backend-work');
});

test('the connection entry point decodes verification', async () => {
  const connection = await import('@raphael/contracts/connection');
  assert.equal(connection.CONNECTION_ROUTES.verify.path, '/api/connection/verify');
  assert.equal(
    Either.isRight(
      connection.decodeVerifyResponse({ protocolVersion: connection.PROTOCOL_VERSION }),
    ),
    true,
  );
});
