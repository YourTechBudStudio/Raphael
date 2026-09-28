import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

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
      assert.deepEqual(response.json, { protocolVersion: PROTOCOL_VERSION });
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

  test('search answers a page of hits over HTTP', async () => {
    await withServer('http-search', async (server) => {
      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Quarterly plan',
          slug: 'quarterly-plan',
          description: 'budget and headcount',
        }),
      });
      assert.equal(created.status, 201);

      const found = await call(server, '/api/nodes/search', {
        body: JSON.stringify({ scopes: [{ path: '/' }], recursive: true, queries: ['headcount'] }),
      });
      assert.equal(found.status, 200);
      const page = found.json as {
        items: { node: { slug: string } }[];
        skip: number;
        limit: number;
        hasMore: boolean;
      };
      assert.deepEqual(
        page.items.map((hit) => hit.node.slug),
        ['quarterly-plan'],
      );
      assert.equal(page.hasMore, false);

      // The relevance score the query computes is not part of the wire contract.
      assert.doesNotMatch(JSON.stringify(found.json), /score|rank/u);
    });
  });

  test('a malformed query is a bounded 400 that echoes no query text', async () => {
    await withServer('http-search-malformed', async (server) => {
      const response = await call(server, '/api/nodes/search', {
        body: JSON.stringify({ scopes: [{ path: '/' }], queries: ['confidentialword AND'] }),
      });
      assert.equal(response.status, 400);
      const error = envelope(response.json);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.message, 'The search query is not well formed.');
      assert.doesNotMatch(JSON.stringify(response.json), /confidentialword/u);
    });
  });

  test('the seeded root areas are listable, and a create answers 201', async () => {
    await withServer('http-create', async (server) => {
      const list = await call(server, '/api/nodes/list', { body: '{"scopes":[{"path":"/"}]}' });
      assert.equal(list.status, 200);
      const items = (list.json as { items: { slug: string }[] }).items;
      assert.deepEqual(
        items.map((item) => item.slug),
        ['personal', 'work'],
      );

      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Ship it',
          slug: 'ship-it',
        }),
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

  test('a slug collision answers 409 naming the slug, and the error is only a code and a message', async () => {
    await withServer('http-slug-conflict', async (server) => {
      const body = JSON.stringify({
        type: 'area',
        parent: { path: '/' },
        title: 'Work',
        slug: 'work',
      });
      const response = await call(server, '/api/nodes/create', { body });

      assert.equal(response.status, 409);
      assert.deepEqual(response.json, {
        error: { code: 'slug_conflict', message: '"work" is already used here.' },
      });
    });
  });

  test('a move answers 200 with the summary under node', async () => {
    await withServer('http-move', async (server) => {
      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Ship it',
          slug: 'ship-it',
        }),
      });
      const entity = (created.json as { entity: { id: number; revision: number } }).entity;

      const moved = await call(server, '/api/nodes/move', {
        body: JSON.stringify({
          target: { id: entity.id },
          revision: entity.revision,
          destination: { path: '/personal/shipped' },
        }),
      });
      // 200, not 201: a move changed an entity that already existed.
      assert.equal(moved.status, 200);
      const node = (
        moved.json as {
          node: { id: number; parentId: number; slug: string; revision: number };
        }
      ).node;
      assert.equal(node.id, entity.id);
      assert.equal(node.slug, 'shipped');
      assert.equal(node.revision, entity.revision + 1);
      assert.equal('body' in node, false, 'a move publishes a summary, not an entity');
    });
  });

  test('archive and restore answer 200, and an archived target refuses an update with 409', async () => {
    await withServer('http-archive', async (server) => {
      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Ship it',
          slug: 'ship-it',
        }),
      });
      const entity = (created.json as { entity: { id: number; revision: number } }).entity;

      const archived = await call(server, '/api/nodes/archive', {
        body: JSON.stringify({ target: { id: entity.id }, revision: entity.revision }),
      });
      assert.equal(archived.status, 200);
      const answer = archived.json as {
        node: { archived: boolean; revision: number };
        archiveCauses: { owner: string; reason: string }[];
      };
      assert.equal(answer.node.archived, true);
      assert.deepEqual(
        answer.archiveCauses.map((cause) => [cause.owner, cause.reason]),
        [['user', 'direct']],
      );

      const refused = await call(server, '/api/nodes/update', {
        body: JSON.stringify({
          target: { id: entity.id },
          revision: answer.node.revision,
          title: 'Renamed',
        }),
      });
      assert.equal(refused.status, 409);
      const error = envelope(refused.json);
      assert.equal(error.code, 'node_archived');
      assert.equal(error.message, 'This is archived.');

      const restored = await call(server, '/api/nodes/restore', {
        body: JSON.stringify({ target: { id: entity.id }, revision: answer.node.revision }),
      });
      assert.equal(restored.status, 200);
      assert.equal((restored.json as { node: { archived: boolean } }).node.archived, false);
    });
  });

  test('adding, listing and removing a favorite each answer 200', async () => {
    await withServer('http-favorites', async (server) => {
      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Ship it',
          slug: 'ship-it',
        }),
      });
      const entity = (created.json as { entity: { id: number } }).entity;

      const added = await call(server, '/api/favorites/add', {
        body: JSON.stringify({ target: { path: '/work/ship-it' } }),
      });
      assert.equal(added.status, 200);
      assert.deepEqual(added.json, { nodeId: entity.id, isFavorite: true });

      const listed = await call(server, '/api/favorites/list', { body: JSON.stringify({}) });
      assert.equal(listed.status, 200);
      const page = listed.json as { items: { id: number; isFavorite: boolean }[]; limit: number };
      assert.deepEqual(
        page.items.map((item) => [item.id, item.isFavorite]),
        [[entity.id, true]],
      );
      assert.equal(page.limit, 50);

      const removed = await call(server, '/api/favorites/remove', {
        body: JSON.stringify({ target: { id: entity.id } }),
      });
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.json, { nodeId: entity.id, isFavorite: false });
    });
  });

  test('an update answers 200, and a stale one 409 with the revision to re-read', async () => {
    await withServer('http-update', async (server) => {
      const created = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/work' },
          title: 'Ship it',
          slug: 'ship-it',
        }),
      });
      const entity = (created.json as { entity: { id: number; revision: number } }).entity;

      const updated = await call(server, '/api/nodes/update', {
        body: JSON.stringify({
          target: { id: entity.id },
          revision: entity.revision,
          title: 'Ship it, properly',
          tags: ['launch'],
          active: true,
        }),
      });
      // 200, not 201: an update changed an entity that already existed rather than creating one.
      assert.equal(updated.status, 200);
      const after = (
        updated.json as {
          entity: { title: string; revision: number; tags: string[]; active: boolean };
        }
      ).entity;
      assert.equal(after.title, 'Ship it, properly');
      assert.equal(after.revision, entity.revision + 1);
      assert.deepEqual(after.tags, ['launch']);
      // The selection travels over the wire on the same body as everything else, through the same
      // route: no endpoint, no envelope and no status code was added for it.
      assert.equal(after.active, true);

      // The same envelope a second time is now stale, because the first one moved the revision.
      const stale = await call(server, '/api/nodes/update', {
        body: JSON.stringify({
          target: { id: entity.id },
          revision: entity.revision,
          title: 'Ship it, properly',
        }),
      });
      assert.equal(stale.status, 409);
      const error = envelope(stale.json);
      assert.equal(error.code, 'revision_conflict');
      assert.equal(
        error.message,
        `This changed on the server. It is now at revision ${after.revision}.`,
      );
    });
  });

  test('an illegal parent answers 422, and a missing one 404', async () => {
    await withServer('http-parentage', async (server) => {
      const atRoot = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/' },
          title: 'Rootless',
          slug: 'rootless',
        }),
      });
      assert.equal(atRoot.status, 422);
      assert.equal(envelope(atRoot.json).code, 'invalid_parent');

      const missing = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'project',
          parent: { path: '/nowhere' },
          title: 'Lost',
          slug: 'lost',
        }),
      });
      assert.equal(missing.status, 404);
      assert.equal(envelope(missing.json).code, 'node_not_found');
    });
  });

  test('a refused kind is a bounded 400 that creates nothing', async () => {
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
          body: JSON.stringify({ ...refusal.body, slug: 'refused' }),
        });
        assert.equal(response.status, 400, refusal.what);
        const error = envelope(response.json);
        assert.equal(error.code, 'invalid_input', refusal.what);
        assert.equal(error.message, `The ${refusal.field} is not valid.`, refusal.what);

        // Nothing from the decoder escapes: its messages can carry the submitted value.
        assert.doesNotMatch(JSON.stringify(response.json), /sketch|Kinded area|Nameless kind/u);
      }

      // Nothing was created. The database still holds exactly what the bootstrap migration seeded, so
      // a refusal that had partially applied would show up here as an extra row.
      const listed = await call(server, '/api/nodes/list', {
        body: JSON.stringify({ scopes: [{ path: '/' }], recursive: true }),
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
    });
  });

  test('an untitled note or container is refused with the title reason, over HTTP', async () => {
    await withServer('http-untitled-note', async (server) => {
      // The union made every non-matching member report `type`, which would have replaced this
      // reason with a complaint about the one field the caller got right.
      const response = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'resource',
          kind: 'note',
          parent: { path: '/work' },
          slug: 'untitled',
          body: { value: '# A heading the server does not use' },
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(envelope(response.json), {
        code: 'invalid_input',
        message: 'Title is required.',
      });

      const container = await call(server, '/api/nodes/create', {
        body: JSON.stringify({ type: 'area', parent: { path: '/' }, slug: 'untitled' }),
      });
      assert.equal(container.status, 400);
      assert.equal(envelope(container.json).message, 'Title is required.');
    });
  });

  test('a note created over HTTP carries its kind, and a container carries null', async () => {
    await withServer('http-note-kind', async (server) => {
      const note = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'resource',
          kind: 'note',
          parent: { path: '/work' },
          title: 'Over the wire',
          slug: 'over-the-wire',
          body: { value: '# Over the wire' },
        }),
      });
      assert.equal(note.status, 201);
      const created = (note.json as { entity: { id: number; kind: string; title: string } }).entity;
      assert.equal(created.kind, 'note');
      assert.equal(created.title, 'Over the wire');

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

  test('an invalid title is refused with a message naming its limit', async () => {
    await withServer('http-invalid-title', async (server) => {
      const response = await call(server, '/api/nodes/create', {
        body: JSON.stringify({
          type: 'area',
          parent: { path: '/' },
          title: 'x'.repeat(201),
          slug: 'long',
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(envelope(response.json), {
        code: 'invalid_input',
        message: 'Title is longer than 200 characters.',
      });
    });
  });
});
