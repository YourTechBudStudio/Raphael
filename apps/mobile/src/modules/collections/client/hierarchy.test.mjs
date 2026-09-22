/**
 * Reading the hierarchy: every page, or nothing.
 *
 * Two properties are being defended. One is that a partial read is never published, whatever goes
 * wrong and wherever it goes wrong - a half-read hierarchy on screen is worse than no hierarchy,
 * because a filter over it answers "nothing matches" about things that simply had not arrived. The
 * other is that pages which contradict each other are refused rather than repaired: offset
 * pagination over a hierarchy someone is editing really can overlap and skip, and the honest answer
 * to that is to say so, not to attach an orphan to the root and call it a tree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClientFailureError } from '../../../infrastructure/query/failure.ts';
import {
  activeProjects,
  areaOptions,
  fetchHierarchy,
  HierarchyRefusedError,
  MAX_CONTAINERS,
  PAGE_LIMIT,
  pathTo,
  subtreeIds,
} from './hierarchy.ts';

const node = (id, type, parentId, title, slug = title.toLowerCase(), active = false) => ({
  id,
  type,
  // Containers have no kind. A summary always carries the field, so the fixtures do too.
  kind: type === 'resource' ? 'note' : null,
  parentId,
  slug,
  revision: 1,
  title,
  description: '',
  tags: [],
  active,
});

/** A server that answers List out of a fixed list, honestly paginated. */
const server = (items, { pageSize = PAGE_LIMIT } = {}) => {
  const calls = [];

  return {
    calls,
    list: (request) => {
      calls.push(request);
      const page = items.slice(request.skip, request.skip + Math.min(request.limit, pageSize));

      return Promise.resolve({
        ok: true,
        value: {
          items: page,
          skip: request.skip,
          limit: request.limit,
          hasMore: request.skip + page.length < items.length,
        },
      });
    },
  };
};

const failing = (failure) => () => Promise.resolve({ ok: false, failure });

const TRANSPORT_FAILURE = {
  kind: 'transport',
  mutationOutcome: 'not_applicable',
  message: 'the exchange failed',
};

describe('pagination', () => {
  it('asks the root recursively and keeps going until there is no more', async () => {
    const items = [
      node(1, 'area', null, 'Work'),
      node(2, 'area', 1, 'Clients'),
      node(3, 'project', 2, 'Design'),
    ];
    const source = server(items, { pageSize: 2 });

    const hierarchy = await fetchHierarchy(source.list);

    assert.equal(source.calls.length, 2);
    assert.deepEqual(source.calls[0].scopes, [{ path: '/' }]);
    assert.equal(source.calls[0].recursive, true);
    assert.equal(source.calls[0].limit, PAGE_LIMIT);
    assert.equal(source.calls[1].skip, 2, 'the second page starts where the first ended');
    assert.equal(hierarchy.byId.size, 3);
  });

  it('publishes nothing when a later page fails', async () => {
    const items = [node(1, 'area', null, 'Work'), node(2, 'area', null, 'Personal')];
    let call = 0;
    const list = (request) => {
      call += 1;
      if (call > 1) return failing(TRANSPORT_FAILURE)();

      return Promise.resolve({
        ok: true,
        value: { items: [items[0]], skip: request.skip, limit: request.limit, hasMore: true },
      });
    };

    await assert.rejects(fetchHierarchy(list), (error) => {
      assert.ok(error instanceof ClientFailureError);
      assert.equal(error.failure.kind, 'transport');

      return true;
    });
  });

  it('a page that promises more and delivers none is refused, not looped on', async () => {
    const list = (request) =>
      Promise.resolve({
        ok: true,
        value: { items: [], skip: request.skip, limit: request.limit, hasMore: true },
      });

    await assert.rejects(fetchHierarchy(list), HierarchyRefusedError);
  });

  it('a page longer than the one it was asked for is refused', async () => {
    const list = (request) =>
      Promise.resolve({
        ok: true,
        value: {
          items: Array.from({ length: PAGE_LIMIT + 1 }, (_, index) =>
            node(index + 1, 'area', null, `A${index}`, `a${index}`),
          ),
          skip: request.skip,
          limit: request.limit,
          hasMore: false,
        },
      });

    await assert.rejects(fetchHierarchy(list), HierarchyRefusedError);
  });

  it('tells a contradiction, which may resolve, from a size, which will not', async () => {
    // The two refusals reach the same screens and must not be offered the same way. A retry is the
    // right thing after a contradiction - the next read is very likely to be consistent - and the
    // wrong thing after a size, where pressing it again can only fail again.
    await assert.rejects(
      fetchHierarchy(server([node(2, 'project', 99, 'Design')]).list),
      (error) => {
        assert.ok(error instanceof HierarchyRefusedError);
        assert.equal(error.retryable, true);

        return true;
      },
    );
  });

  it('stops rather than reading forever when hasMore never becomes false', async () => {
    let next = 0;
    const list = (request) => {
      const items = Array.from({ length: PAGE_LIMIT }, () => {
        next += 1;

        return node(next, 'area', null, `A${next}`, `a${String(next).padStart(8, '0')}`);
      });

      return Promise.resolve({
        ok: true,
        value: { items, skip: request.skip, limit: request.limit, hasMore: true },
      });
    };

    await assert.rejects(fetchHierarchy(list), (error) => {
      assert.ok(error instanceof HierarchyRefusedError);
      assert.equal(error.retryable, false, 'a size is settled, so no retry is offered');
      assert.match(error.message, new RegExp(String(MAX_CONTAINERS)));

      return true;
    });
    assert.ok(next > MAX_CONTAINERS);
  });

  it('passes the caller’s signal to every page', async () => {
    const controller = new AbortController();
    const seen = [];
    const items = [node(1, 'area', null, 'A'), node(2, 'area', null, 'B')];
    const list = (request, signal) => {
      seen.push(signal);
      const page = items.slice(request.skip, request.skip + 1);

      return Promise.resolve({
        ok: true,
        value: {
          items: page,
          skip: request.skip,
          limit: request.limit,
          hasMore: request.skip + page.length < items.length,
        },
      });
    };

    await fetchHierarchy(list, controller.signal);

    assert.equal(seen.length, 2);
    assert.ok(seen.every((signal) => signal === controller.signal));
  });
});

describe('assembly refuses to invent a hierarchy', () => {
  const rejects = async (items) => {
    await assert.rejects(fetchHierarchy(server(items).list), HierarchyRefusedError);
  };

  it('refuses a container whose parent never arrived', async () => {
    // Exactly what an offset page boundary shifting under an insert produces.
    await rejects([node(2, 'project', 99, 'Design')]);
  });

  it('refuses the same container twice', async () => {
    await rejects([node(1, 'area', null, 'Work'), node(1, 'area', null, 'Work')]);
  });

  it('refuses a project at the top level, and a container inside a project', async () => {
    await rejects([node(1, 'project', null, 'Design')]);
    await rejects([node(1, 'project', null, 'Design'), node(2, 'area', 1, 'Inside')]);
  });

  it('refuses a loop', async () => {
    await rejects([node(1, 'area', 2, 'A'), node(2, 'area', 1, 'B')]);
  });
});

describe('the assembled tree', () => {
  const items = [
    node(2, 'area', null, 'Work', 'work'),
    node(1, 'area', null, 'Personal', 'personal'),
    node(4, 'project', 2, 'Design', 'design'),
    node(3, 'area', 2, 'Clients', 'clients'),
    node(5, 'area', 3, 'Acme', 'acme'),
  ];

  it('nests by parent and orders siblings the way the server does', async () => {
    const hierarchy = await fetchHierarchy(server(items).list);

    assert.deepEqual(
      hierarchy.roots.map((root) => root.title),
      ['Personal', 'Work'],
      'slug order, not arrival order',
    );
    assert.deepEqual(
      hierarchy.byId.get(2).children.map((child) => child.title),
      ['Clients', 'Design'],
    );
  });

  it('walks a path from the top-level area down to a node', async () => {
    const hierarchy = await fetchHierarchy(server(items).list);

    assert.deepEqual(
      pathTo(hierarchy, 5).map((step) => step.title),
      ['Work', 'Clients', 'Acme'],
    );
    assert.deepEqual(pathTo(hierarchy, 404), []);
  });

  it('collects a subtree including its root, for scoping a search', async () => {
    const hierarchy = await fetchHierarchy(server(items).list);

    assert.deepEqual([...subtreeIds(hierarchy, 3)].sort(), [3, 5]);
    assert.deepEqual([...subtreeIds(hierarchy, 404)], []);
  });

  it('carries the revision and the selection through projection', async () => {
    const hierarchy = await fetchHierarchy(
      server([
        node(2, 'area', null, 'Work', 'work'),
        { ...node(4, 'project', 2, 'Design', 'design', true), revision: 7 },
      ]).list,
    );

    // Both are dropped by a projection that keeps only what a card draws, and both are needed: the
    // revision is what a write initiated from a card is guarded by, and the selection is what puts
    // the card on Home in the first place.
    const project = hierarchy.byId.get(4);
    assert.equal(project.revision, 7);
    assert.equal(project.active, true);
    assert.equal(hierarchy.byId.get(2).revision, 1);
    assert.equal(hierarchy.byId.get(2).active, false);
  });

  it('walks the active projects in hierarchy order, and no areas', async () => {
    // Deliberately interleaved: `Zulu` sorts after `Design` among Work's children, so a walk that
    // took areas before projects, or that read `byId` insertion order, would answer differently.
    const selected = [
      node(1, 'area', null, 'Personal', 'personal'),
      node(2, 'area', null, 'Work', 'work'),
      node(3, 'project', 1, 'Kitchen', 'kitchen', true),
      node(4, 'project', 2, 'Design', 'design', true),
      node(5, 'area', 2, 'Zulu', 'zulu'),
      node(6, 'project', 5, 'Acme', 'acme', true),
      node(7, 'project', 2, 'Dormant', 'dormant'),
    ];
    const hierarchy = await fetchHierarchy(server(selected).list);

    assert.deepEqual(
      activeProjects(hierarchy).map((project) => project.title),
      ['Kitchen', 'Design', 'Acme'],
      'pre-order over the roots, each area\u2019s children in the server\u2019s order',
    );
    // An area is never active - the contract refuses the pairing - and an unselected project is not
    // drawn on Home even though it is in the tree.
    assert.ok(activeProjects(hierarchy).every((project) => project.type === 'project'));
    assert.equal(
      activeProjects(hierarchy).find((project) => project.title === 'Dormant'),
      undefined,
    );
  });

  it('has nothing to show when nothing is selected', async () => {
    const hierarchy = await fetchHierarchy(server(items).list);

    assert.deepEqual(activeProjects(hierarchy), []);
  });

  it('offers areas with enough context to tell two of the same name apart', async () => {
    const shadowed = [
      node(1, 'area', null, 'Work', 'work'),
      node(2, 'area', null, 'Personal', 'personal'),
      node(3, 'area', 1, 'Notes', 'notes'),
      node(4, 'area', 2, 'Notes', 'notes'),
      node(5, 'project', 1, 'Design', 'design'),
    ];
    const hierarchy = await fetchHierarchy(server(shadowed).list);
    const options = areaOptions(hierarchy);

    assert.deepEqual(
      options.map((option) => `${option.title}|${option.context}`),
      ['Personal|', 'Notes|Personal', 'Work|', 'Notes|Work'],
      'projects are not destinations, and every area says where it sits',
    );
    // The filter matches what is on screen, both halves of it.
    assert.equal(options.filter((option) => option.haystack.includes('work')).length, 2);
  });
});

describe('the widened server vocabulary', () => {
  it('asks for containers explicitly rather than relying on the default', async () => {
    const backing = server([node(1, 'area', null, 'Work')]);
    await fetchHierarchy(backing.list);

    // An unfiltered list is every node type, which includes notes. A hierarchy built from a list
    // containing leaves would be a tree this app cannot hold, so the filter is named.
    assert.ok(backing.calls.length > 0);
    for (const request of backing.calls) {
      assert.deepEqual([...request.filter.type.$in].sort(), ['area', 'project']);
      assert.equal(request.recursive, true);
    }
  });

  it('refuses a resource in the answer rather than quietly dropping it', async () => {
    const backing = server([
      node(1, 'area', null, 'Work'),
      node(2, 'resource', 1, 'A note', 'a-note'),
    ]);

    // Filtering it out would turn a server answering the wrong question into a hierarchy that merely
    // looks a little short - and the children of a dropped row would then read as orphans against a
    // cause nobody could see.
    await assert.rejects(() => fetchHierarchy(backing.list), HierarchyRefusedError);
  });

  it('still refuses a resource that arrives at the top level', async () => {
    const backing = server([node(1, 'resource', null, 'Loose note', 'loose-note')]);
    await assert.rejects(() => fetchHierarchy(backing.list), HierarchyRefusedError);
  });
});
