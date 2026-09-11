import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { call, envelope, withServer } from './server-support.ts';

/**
 * The operations, over HTTP.
 *
 * These do not re-test hierarchy rules - phase 04 owns those against the core directly. What they
 * establish is that the transport carries an operation's result and its failures faithfully: the
 * right status, the published envelope, the capability's own reasons, and nothing added or lost in
 * between.
 */

describe('operations over HTTP', () => {
  test('verification answers a protocol version and nothing else', async () => {
    await withServer('http-verify', async (server) => {
      const response = await call(server, '/api/connection/verify', { body: '{}' });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { protocolVersion: 1 });
    });
  });

  test('verification is not exempt from the shared request contract', async () => {
    await withServer('http-verify-strict', async (server) => {
      const response = await call(server, '/api/connection/verify', {
        body: '{"unexpected":true}',
      });
      assert.equal(response.status, 400);
      assert.equal(envelope(response.json).code, 'invalid_input');
    });
  });

  test('the seeded root areas are listable, and a create answers 201', async () => {
    await withServer('http-create', async (server) => {
      const list = await call(server, '/api/nodes/list', { body: '{"parent":{"path":"/"}}' });
      assert.equal(list.status, 200);
      const items = (list.json as { items: { slug: string }[] }).items;
      assert.deepEqual(
        items.map((item) => item.slug),
        ['personal', 'work'],
      );

      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'project', parent: { path: '/work' }, title: 'Ship it' }),
      });
      assert.equal(created.status, 201);
      const entity = (
        created.json as { entity: { id: number; slug: string; title: string; revision: number } }
      ).entity;
      assert.equal(entity.slug, 'ship-it');
      assert.equal(entity.title, 'Ship it');
      assert.equal(entity.revision, 1);

      const fetched = await call(server, '/api/nodes/get', {
        body: JSON.stringify({ target: { id: entity.id } }),
      });
      assert.equal(fetched.status, 200);
      assert.equal((fetched.json as { entity: { slug: string } }).entity.slug, 'ship-it');

      const path = await call(server, '/api/nodes/get-path', {
        body: JSON.stringify({ target: { id: entity.id } }),
      });
      assert.equal(path.status, 200);
      assert.equal((path.json as { path: string }).path, '/work/ship-it');
    });
  });

  test('a replayed creation is a success with the same 201, not a distinct outcome', async () => {
    await withServer('http-replay', async (server) => {
      const request = JSON.stringify({
        type: 'area',
        parent: { path: '/' },
        title: 'Reading',
        idempotencyKey: '2f8a6b20-0d0e-4a6f-bb5e-2a1f3c4d5e6f',
      });
      const first = await call(server, '/api/nodes/create', { body: request });
      const second = await call(server, '/api/nodes/create', { body: request });

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.deepEqual(second.json, first.json);
    });
  });

  test('a differing retry on the same key conflicts, with the capability’s own reason', async () => {
    await withServer('http-replay-conflict', async (server) => {
      const key = '3a9b7c31-1e1f-4b7a-9c6f-3b2e4d5f6a7b';
      await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'area',
          parent: { path: '/' },
          title: 'First',
          idempotencyKey: key,
        }),
      });
      const differing = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'area',
          parent: { path: '/' },
          title: 'Second',
          idempotencyKey: key,
        }),
      });

      assert.equal(differing.status, 409);
      const error = envelope(differing.json);
      assert.equal(error.code, 'idempotency_conflict');
      assert.equal(error.details.reason, 'different_input');
    });
  });

  test('a slug collision answers 409 with the conflicting slug and scope', async () => {
    await withServer('http-slug-conflict', async (server) => {
      const body = JSON.stringify({ type: 'area', parent: { path: '/' }, title: 'Work' });
      const response = await call(server, '/api/nodes/create', { body });

      assert.equal(response.status, 409);
      const error = envelope(response.json);
      assert.equal(error.code, 'slug_conflict');
      assert.equal(error.details.slug, 'work');
      assert.equal(error.details.scope, 'root');
    });
  });

  test('an illegal parent answers 422, and a missing one 404', async () => {
    await withServer('http-parentage', async (server) => {
      const atRoot = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'project', parent: { path: '/' }, title: 'Rootless' }),
      });
      assert.equal(atRoot.status, 422);
      assert.equal(envelope(atRoot.json).code, 'invalid_parent');

      const missing = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'project', parent: { path: '/nowhere' }, title: 'Lost' }),
      });
      assert.equal(missing.status, 404);
      assert.equal(envelope(missing.json).code, 'node_not_found');
    });
  });

  test('an invalid title carries the capability’s structured reason and its limit', async () => {
    await withServer('http-invalid-title', async (server) => {
      const response = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'area', parent: { path: '/' }, title: 'x'.repeat(201) }),
      });
      assert.equal(response.status, 400);
      const error = envelope(response.json);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.details.field, 'title');
      assert.equal(error.details.reason, 'title_too_long');
      assert.equal(error.details.limit, 200);
    });
  });
});
