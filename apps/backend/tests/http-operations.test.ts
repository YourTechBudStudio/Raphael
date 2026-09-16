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

  test('a refused kind is a bounded 400 that creates nothing and settles no key', async () => {
    await withServer('http-kind-refusals', async (server) => {
      // Every shape the creation union refuses, over the wire rather than against the decoder
      // directly. The union changed which member reports what, and this is the whole path that
      // turns that into a public answer: JSON parsing, strict decoding, diagnostic selection, and
      // the error mapping that assigns the status.
      const refusals = [
        {
          what: 'a resource that does not say what it is',
          body: { type: 'resource', parent: { path: '/work' }, title: 'Nameless kind' },
          field: 'kind',
        },
        {
          what: 'a resource kind core does not admit',
          body: { type: 'resource', kind: 'sketch', parent: { path: '/work' }, title: 'Sketch' },
          field: 'kind',
        },
        {
          what: 'a container carrying a kind',
          body: { type: 'area', kind: 'note', parent: { path: '/' }, title: 'Kinded area' },
          field: 'kind',
        },
      ];

      for (const refusal of refusals) {
        const response = await call(server, '/api/nodes/create', {
          body: JSON.stringify({ ...refusal.body, idempotencyKey: `key-${refusal.field}` }),
        });
        assert.equal(response.status, 400, refusal.what);
        const error = envelope(response.json);
        assert.equal(error.code, 'invalid_input', refusal.what);
        assert.equal(error.details.field, refusal.field, refusal.what);
        assert.equal(error.details.reason, 'invalid', refusal.what);

        // Nothing from the decoder escapes. Its formatted messages can carry the submitted value and
        // arbitrary property names, so the published details are only our own closed vocabulary.
        assert.deepEqual(Object.keys(error.details).sort(), ['field', 'reason'], refusal.what);
        assert.doesNotMatch(JSON.stringify(response.json), /sketch|Kinded area|Nameless kind/u);
      }

      // Nothing was created. The database still holds exactly what the bootstrap migration seeded, so
      // a refusal that had partially applied would show up here as an extra row.
      const listed = await call(server, '/api/nodes/list', {
        body: JSON.stringify({ parent: { path: '/' }, recursive: true }),
      });
      assert.equal(listed.status, 200);
      const remaining = (listed.json as { items: { slug: string; type: string }[] }).items;
      assert.deepEqual(
        remaining.map((item) => item.slug),
        ['personal', 'work'],
      );
      assert.equal(
        remaining.every((item) => item.type === 'area'),
        true,
        'the two seeded root areas, and nothing the refusals left behind',
      );

      // And no key was settled. A receipt written for a refused request would make this reuse replay
      // the failure instead of creating, so a 201 here is what proves the ledger stayed clean.
      const reused = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'resource',
          kind: 'note',
          parent: { path: '/work' },
          title: 'Now valid',
          idempotencyKey: 'key-kind',
        }),
      });
      assert.equal(reused.status, 201);
      const entity = (reused.json as { entity: { kind: string; type: string } }).entity;
      assert.equal(entity.type, 'resource');
      assert.equal(entity.kind, 'note');
    });
  });

  test('a note that cannot be named is refused with the title reason, over HTTP', async () => {
    await withServer('http-untitled-note', async (server) => {
      // The union made every non-matching member report `type`, which would have replaced this
      // reason with a complaint about the one field the caller got right.
      const response = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'resource', kind: 'note', parent: { path: '/work' } }),
      });
      assert.equal(response.status, 400);
      const error = envelope(response.json);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.details.field, 'title');
      assert.equal(error.details.reason, 'title_required');

      // A container missing its title still reaches the same reason by the same route.
      const container = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'area', parent: { path: '/' } }),
      });
      assert.equal(container.status, 400);
      assert.equal(envelope(container.json).details.reason, 'title_required');
    });
  });

  test('a note created over HTTP carries its kind, and a container carries null', async () => {
    await withServer('http-note-kind', async (server) => {
      const note = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'resource',
          kind: 'note',
          parent: { path: '/work' },
          body: { value: '# Derived over the wire' },
        }),
      });
      assert.equal(note.status, 201);
      const created = (note.json as { entity: { id: number; kind: string; title: string } }).entity;
      assert.equal(created.kind, 'note');
      assert.equal(created.title, 'Derived over the wire');

      const read = await call(server, '/api/nodes/get', {
        body: JSON.stringify({ target: { id: created.id } }),
      });
      assert.equal(read.status, 200);
      const entity = (read.json as { entity: Record<string, unknown> }).entity;
      assert.equal(entity['kind'], 'note');

      // The response surface is exactly what the contract publishes: `kind` joined it, and the
      // derived-text column did not.
      assert.equal('body_text' in entity, false);
      assert.equal('bodyText' in entity, false);
      assert.equal('updatedAt' in entity, false);

      const containerRead = await call(server, '/api/nodes/get', {
        body: JSON.stringify({ target: { path: '/work' } }),
      });
      const container = (containerRead.json as { entity: Record<string, unknown> }).entity;
      assert.equal('kind' in container, true, 'always present, never inferred from the type');
      assert.equal(container['kind'], null);
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
