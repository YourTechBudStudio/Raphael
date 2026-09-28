/**
 * One note, two clients.
 *
 * Story #3 promises that what the CLI writes is what the phone reads, and the other way round. That
 * is a claim about a crossing, and neither client's own suite can make it: `apps/cli`'s remote tests
 * prove the CLI's argument forms against the server, and this package's retrieval tests prove the
 * phone's queries against the server, but nothing until here writes with one and reads with the
 * other. So every case below creates through one real client and asserts through the other.
 *
 * **Deliberately not re-tested here.** Flag parsing, local refusals, format selection and ordering
 * clauses belong to `apps/cli/tests/remote.test.ts` and are proven there. What is new at this level
 * is that the *crossing* preserves title, description, canonical body, revision, numeric identity
 * and kind - and that the content fixtures survive real storage rather than only conversion.
 *
 * The phone writing through `unsent` is proven against the server in `unsent-server.test.mjs`.
 *
 * **What this is not.** No Expo runtime, no WebView, no `expo-sqlite`. The device run remains a
 * human-assisted check.
 *
 * Listeners, child processes and directories are torn down before the test returns, including when
 * an assertion fails.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTransport } from '@raphael/client';
import { get, removeFavorite, restore, update } from '@raphael/client/nodes';
import { QueryClient } from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../src/infrastructure/query/failure.ts';
import { activeProjects } from '../src/modules/collections/client/hierarchy.ts';
import {
  favoritePagesOptions,
  flattenFavoritePages,
} from '../src/modules/favorites/client/options.ts';
import { notePagesOptions } from '../src/modules/resources/client/options.ts';
import { containerDescriptor, feedDescriptor } from '../src/modules/resources/client/requests.ts';
import { toNoteSummaryItem } from '../src/modules/resources/client/summary.ts';
import {
  cleanupDirectories,
  cliJson,
  hierarchyOver,
  KEY,
  phoneTransport,
  runCli,
  temporaryDir,
  withServer,
} from './support/cross-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', 'packages', 'content', 'tests', 'fixtures');

const documentWith = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const fixture = async (name, file) => readFile(path.join(fixtures, name, file), 'utf8');

after(cleanupDirectories);

/** A client that does not retry, so a real failure is observed as one. */
const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

/** Every page of a traversal, fetched the way the feed fetches them. */
const allPages = async (client, options) => {
  const { InfiniteQueryObserver } = await import('@tanstack/react-query');
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    await observer.refetch();
    while (observer.getCurrentResult().hasNextPage) await observer.fetchNextPage();

    return observer.getCurrentResult().data.pages;
  } finally {
    unsubscribe();
  }
};

/**
 * The seeded area every case files its note under.
 *
 * A fresh database seeds `/work` and `/personal`; using the seeded one rather than creating another
 * keeps each case to the one creation it is actually about.
 */
const WORK = { path: '/work', id: 1 };

/** The other seeded area. Used where a case needs two roots to have an order at all. */
const PERSONAL = { path: '/personal', id: 2 };

describe('a note the CLI wrote, read by the phone', () => {
  /**
   * Each row is one body input form the story requires, carrying content worth putting through
   * storage. Every one is created by the real CLI process and read back through the phone's own
   * query seams, so the input forms are distributed across real round trips rather than multiplied
   * into a matrix that proves the same crossing six times.
   */
  const cases = [
    {
      name: 'inline Markdown, with nested lists',
      slug: 'inline-nested',
      title: 'Inline nested lists',
      description: 'Written inline',
      body: async () => ({ markdown: await fixture('nested-lists', 'input.md') }),
      expected: () => fixture('nested-lists', 'expected-export.md'),
      args: async (body) => [`--body=${body.markdown}`],
    },
    {
      name: 'a file, holding a Mermaid block',
      slug: 'from-file',
      title: 'Mermaid from a file',
      description: 'Read from a file',
      body: async () => ({ markdown: await fixture('mermaid-code', 'input.md') }),
      expected: () => fixture('mermaid-code', 'expected-export.md'),
      args: async (body, dir) => {
        const file = path.join(dir, 'note.md');
        await writeFile(file, body.markdown, 'utf8');

        return [`--body=@${file}`];
      },
    },
    {
      name: 'standard input, with blank lines inside a fence',
      slug: 'from-stdin',
      title: 'Mermaid over stdin',
      description: 'Piped in',
      body: async () => ({ markdown: await fixture('mermaid-blank-lines', 'input.md') }),
      expected: () => fixture('mermaid-blank-lines', 'expected-export.md'),
      args: async () => ['--body=@-'],
      stdin: (body) => body.markdown,
    },
    {
      name: 'a literal @, which is text and not a path',
      slug: 'literal-at',
      title: 'A literal at sign',
      description: 'Not a file reference',
      body: async () => ({ markdown: '@rewrite-this.md is the plan' }),
      expected: async () => '@rewrite-this.md is the plan',
      args: async (body) => [`--body-literal=${body.markdown}`],
    },
    {
      name: 'an explicit TipTap document',
      slug: 'explicit-tiptap',
      title: 'Submitted as TipTap',
      description: 'Canonical on the way in',
      body: async () => ({
        markdown: 'Straight from the editor',
        tiptap: documentWith('Straight from the editor'),
      }),
      expected: async () => 'Straight from the editor',
      args: async (body) => ['--body-format', 'tiptap', `--body=${JSON.stringify(body.tiptap)}`],
    },
    {
      name: 'no body at all, named by its title',
      slug: 'no-body',
      title: 'Only a title and a description',
      description: 'There is no body here',
      body: async () => ({ markdown: '' }),
      expected: async () => '',
      args: async () => [],
    },
  ];

  it('preserves title, description, canonical body, revision, identity and kind for every input form', async () => {
    const dir = await temporaryDir('cli-writes-');

    await withServer(async ({ endpoint }) => {
      // The phone's own read of one note is the editor's Get, asking for the canonical format.
      const phone = phoneTransport(endpoint);

      for (const row of cases) {
        const body = await row.body();
        const created = await cliJson(
          [
            'create',
            'resource.note',
            `${WORK.path}/${row.slug}`,
            '--title',
            row.title,
            '--description',
            row.description,
            ...(await row.args(body, dir)),
          ],
          {
            endpoint,
            ...(row.stdin === undefined ? {} : { stdin: row.stdin(body) }),
          },
        );

        const written = created.entity;
        assert.equal(written.kind, 'note', `${row.name}: kind`);
        assert.equal(written.type, 'resource', `${row.name}: type`);
        assert.equal(written.revision, 1, `${row.name}: revision`);
        assert.ok(Number.isInteger(written.id) && written.id > 0, `${row.name}: identity`);

        const opened = unwrap(
          await get(phone, { target: { id: written.id }, format: 'tiptap' }),
        ).entity;
        assert.equal(opened.parentId, WORK.id, `${row.name}: same parent`);
        assert.equal(opened.revision, 1, `${row.name}: same revision`);
        assert.equal(opened.kind, 'note', `${row.name}: same kind`);
        assert.equal(opened.type, 'resource', `${row.name}: same type`);
        assert.equal(opened.slug, row.slug, `${row.name}: same slug`);
        assert.equal(opened.title, row.title, `${row.name}: same title`);
        assert.equal(opened.description, row.description, `${row.name}: same description`);

        // And the same note, read back as Markdown through the client that wrote it: the fixture's
        // own expected export, which is what "the content survived storage" means here.
        const asMarkdown = await cliJson(['get', '--id', String(written.id)], { endpoint });
        assert.equal(
          asMarkdown.entity.body.value,
          (await row.expected()).replace(/\n$/, ''),
          `${row.name}: Markdown export after a real round trip`,
        );

        // By path as well as by id, and the two agree on everything.
        const byPath = await cliJson(['get', `${WORK.path}/${row.slug}`, '--format', 'tiptap'], {
          endpoint,
        });
        assert.equal(
          byPath.entity.id,
          written.id,
          `${row.name}: id and path address the same note`,
        );
        // A body the editor can open: the server's canonical document, not a projection of it.
        assert.equal(byPath.entity.body.format, 'tiptap', `${row.name}: canonical body`);
        assert.deepEqual(
          opened.body.value,
          byPath.entity.body.value,
          `${row.name}: the editor is given the body the server holds`,
        );
      }
    });
  });

  it('puts them all in the phone feed and in their container, through real paging', async () => {
    await withServer(async ({ endpoint }) => {
      const client = freshClient();
      const transport = phoneTransport(endpoint);
      const titles = [];

      for (let index = 0; index < 3; index += 1) {
        const title = `Feed note ${String(index)}`;
        titles.push(title);
        await cliJson(
          ['create', 'resource.note', `${WORK.path}/feed-${String(index)}`, '--title', title],
          { endpoint },
        );
      }

      const feed = await allPages(
        client,
        notePagesOptions(1, transport, (skip) => feedDescriptor(skip), true),
      );
      const feedTitles = feed.flatMap((page) => page.items.map((item) => item.title));
      for (const title of titles) {
        assert.ok(feedTitles.includes(title), `${title} is in the phone's feed`);
      }

      const inside = await allPages(
        client,
        notePagesOptions(1, transport, (skip) => containerDescriptor(WORK.id, skip, false), true),
      );
      const insideTitles = inside.flatMap((page) => page.items.map((item) => item.title));
      for (const title of titles) {
        assert.ok(insideTitles.includes(title), `${title} is in the area's notes`);
      }

      // The guard that keeps anything but a note out of a notes grid is on the real summaries too:
      // the seeded areas are in the same tree and reach neither list.
      const everyItem = [...feed, ...inside].flatMap((page) => page.items);
      for (const item of everyItem) {
        assert.equal(item.parentId, WORK.id);
        assert.ok(Number.isInteger(item.id));
      }
      assert.equal(
        toNoteSummaryItem({
          id: WORK.id,
          type: 'area',
          kind: null,
          parentId: null,
          slug: 'work',
          revision: 1,
          title: 'Work',
          description: '',
          tags: [],
          active: false,
          archived: false,
          isFavorite: false,
        }),
        null,
        'a container is never mapped into a notes grid',
      );
    });
  });
});

/**
 * One project's selection, written by one client and read by the other.
 *
 * Story #5 asks for a selection that is "consistent across clients", and until this file said so the
 * only regression coverage of active selection anywhere in the repository was three assertions
 * against an in-memory `Map`. Neither client's own suite can make the claim: `apps/cli`'s remote
 * tests prove the flags against the server, and `active-toggle.test.mjs` proves the phone's hook
 * against a transport it controls, but nothing until here writes with one and reads with the other.
 *
 * Both directions, because they are different paths through different decoders. A CLI write read by
 * the phone crosses `NodeSummary` inside a List page and then the hierarchy projection; a phone write
 * read by the CLI crosses the update envelope and then `NodeEntity`. Criterion 1's "both clients"
 * claim is only as good as the weaker one.
 *
 * The phone side issues the call `useProjectActive`'s `mutationFn` issues - `update(transport, {
 * target: { id }, revision, active })` through the same `unwrap` - rather than mounting the hook. The
 * crossing is a claim about the fact, not about React Query's plumbing, and that plumbing is already
 * pinned deterministically against a controllable fake. Nothing in this file is stubbed, and adding
 * the renderer's module-scope stubs here to reach the hook would end that.
 */
describe("a project's selection, across the two clients", () => {
  /**
   * A project the CLI created, so the pre-crossing state is server-shaped.
   *
   * The path is returned beside the entity because a response carries `slug` and `parentId` and no
   * path - which is ADR 0004's point, that a path is computed and an id is identity - and the CLI is
   * addressed by path here on purpose, since that is how a person reaches a project at a terminal.
   */
  const projectAt = async (endpoint, slug, parent = WORK.path) => {
    const at = `${parent}/${slug}`;
    const { entity } = await cliJson(['create', 'project', at, '--title', slug], { endpoint });

    return { ...entity, at };
  };

  it('is set by the terminal and read by the phone, in the order Home draws it', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);

      // Two under one area and one under the other, so the ordering assertion below has something
      // to order. Created out of slug order deliberately.
      const b = await projectAt(endpoint, 'crossing-b');
      const a = await projectAt(endpoint, 'crossing-a');
      const c = await projectAt(endpoint, 'crossing-c', PERSONAL.path);
      assert.equal(a.active, false, 'a project is created inactive');

      const before = await hierarchyOver(transport);
      assert.equal(before.byId.get(a.id).active, false, 'and the phone reads it that way');
      assert.deepEqual(activeProjects(before), [], 'so Home has nothing to draw');

      for (const project of [b, a, c]) {
        const ran = await runCli(['update', project.at, '--active'], { endpoint });
        assert.equal(ran.code, 0, ran.stderr);
      }

      const selected = await hierarchyOver(transport);
      const node = selected.byId.get(a.id);
      assert.equal(node.active, true, 'the phone reads what the terminal wrote');
      assert.equal(node.revision, a.revision + 1, 'at the revision the write produced');
      assert.equal(node.type, 'project');

      // The projection Home actually draws, not merely the field. `activeProjects` is a named walk
      // in hierarchy order - pre-order over roots, children already sorted - and until here that
      // order had evidence only against hand-built fixtures. `/personal` sorts before `/work`, and
      // `crossing-a` before `crossing-b` inside it.
      assert.deepEqual(
        activeProjects(selected).map((found) => found.slug),
        ['crossing-c', 'crossing-a', 'crossing-b'],
      );

      // An area is never active and never reaches that list, whatever else is selected.
      assert.equal(selected.byId.get(WORK.id).active, false);

      // And through the phone's *other* decoder. The hierarchy arrives as `NodeSummary` inside a List
      // page; the Project screen reads its entity from Get, and builds the revision its toggle writes
      // against from that reading rather than from the tree. Same struct, different response, so the
      // crossing is asserted on both paths the phone actually takes.
      const entity = unwrap(await get(transport, { target: { id: a.id } })).entity;
      assert.equal(entity.active, true);
      assert.equal(entity.revision, node.revision, 'and the two readings agree');
    });
  });

  it('is cleared by the phone and read by the terminal', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const project = await projectAt(endpoint, 'phone-clears');
      const activated = await runCli(['update', project.at, '--active'], { endpoint });
      assert.equal(activated.code, 0, activated.stderr);

      // What the phone read is what it writes against: the revision travels with the state, from the
      // same reading, which is why `HierarchyNode` carries one at all.
      const read = (await hierarchyOver(transport)).byId.get(project.id);
      assert.equal(read.active, true);

      const answered = unwrap(
        await update(transport, {
          target: { id: read.id },
          revision: read.revision,
          active: false,
        }),
      );
      assert.equal(answered.entity.active, false, 'the server answered with the resulting state');
      assert.equal(answered.entity.revision, read.revision + 1);

      const atTerminal = await cliJson(['get', project.at], { endpoint });
      assert.equal(atTerminal.entity.active, false, 'the terminal reads what the phone wrote');
      assert.equal(atTerminal.entity.revision, answered.entity.revision);

      // And the human-readable form a person actually looks at.
      const shown = await runCli(['get', project.at], { endpoint });
      assert.match(shown.stdout, /^active: no$/m);
    });
  });

  it('refuses a phone write from a reading the terminal has already moved past', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const project = await projectAt(endpoint, 'stale-phone');

      // The reading the phone is holding, taken before the terminal writes.
      const stale = (await hierarchyOver(transport)).byId.get(project.id);
      assert.equal(stale.active, false);

      const moved = await runCli(['update', project.at, '--active'], { endpoint });
      assert.equal(moved.code, 0, moved.stderr);

      // Desired state, not a toggle, and still refused: `false` from a revision that has moved would
      // silently undo a decision this client never saw. The guard is what makes that a refusal rather
      // than a last-writer-wins race, and it is asserted here against a real server because
      // `active-toggle.test.mjs` can only assert it against an answer it wrote itself.
      const refusal = await (async () => {
        try {
          unwrap(
            await update(transport, {
              target: { id: stale.id },
              revision: stale.revision,
              active: false,
            }),
          );
        } catch (error) {
          return asClientFailure(error);
        }

        return assert.fail('a stale selection write was accepted');
      })();

      // Checked before it is read: `asClientFailure` answers null for anything that is not one, and
      // this is the case whose whole value is *which* refusal came back.
      assert.ok(refusal !== null, 'expected a client failure');
      assert.equal(refusal.kind, 'http');
      assert.equal(refusal.code, 'revision_conflict');

      const atTerminal = await cliJson(['get', project.at], { endpoint });
      assert.equal(atTerminal.entity.active, true, 'nothing was undone');
      assert.equal(atTerminal.entity.revision, stale.revision + 1, 'and exactly one write landed');
    });
  });
});

/**
 * One entity, two clients, changed by both.
 *
 * Editing is the first operation where the two clients' interaction models genuinely diverge:
 * `raphael update` names a revision the person read, and the phone autosaves against a base it keeps
 * for itself. Everything else about the crossing has been the same request in two spellings; this is
 * two different ideas of what a safe write is, meeting at one compare-and-set.
 *
 * So these cases are not "the CLI can update and so can the phone". They are the four places where
 * one client's idea could quietly overwrite the other's, plus one measurement of a window the design
 * knowingly left open.
 */
describe('one entity, moved by either client', () => {
  /** Created at a terminal, so each case starts from server-shaped entities. */
  const created = async (endpoint, args) =>
    (await cliJson(['create', ...args], { endpoint })).entity;
  const entityOf = async (endpoint, id) =>
    (await cliJson(['get', '--id', String(id)], { endpoint })).entity;
  const pathOf = async (endpoint, id) => {
    const ran = await runCli(['path', '--id', String(id)], { endpoint });

    assert.equal(ran.code, 0, ran.stderr);

    return ran.stdout.trim();
  };
  /** What the phone reads of a container: where it hangs, its address, and its revision. */
  const placed = (hierarchy, id) => {
    const node = hierarchy.byId.get(id);

    return { parentId: node.parentId, slug: node.slug, revision: node.revision };
  };

  it('moves an area at the terminal, and the phone reads its whole subtree in the new place', async () => {
    await withServer(async ({ endpoint }) => {
      const outer = await created(endpoint, [
        'area',
        `${WORK.path}/move-outer`,
        '--title',
        'Outer',
      ]);
      const plans = await created(endpoint, [
        'project',
        `${WORK.path}/move-outer/plans`,
        '--title',
        'Plans',
      ]);
      const inside = await created(endpoint, [
        'resource.note',
        `${WORK.path}/move-outer/plans/inside`,
        '--title',
        'Inside',
        '--body-literal',
        'Deep down',
      ]);
      const transport = createTransport({ endpoint, apiKey: KEY, fetch });

      const before = await hierarchyOver(transport);

      assert.equal(before.byId.get(outer.id).parentId, WORK.id);

      const ran = await runCli(['move', `${WORK.path}/move-outer`, PERSONAL.path], { endpoint });

      assert.equal(ran.code, 0, ran.stderr);

      // The phone re-reads the hierarchy, as its cache does after invalidation.
      const reread = await hierarchyOver(transport);

      assert.deepEqual(placed(reread, outer.id), {
        parentId: PERSONAL.id,
        slug: 'move-outer',
        revision: outer.revision + 1,
      });
      assert.ok(reread.byId.get(PERSONAL.id).children.some((child) => child.id === outer.id));
      assert.ok(!reread.byId.get(WORK.id).children.some((child) => child.id === outer.id));
      // A descendant is not rewritten: same parent, same revision. Only its computed path changed.
      assert.deepEqual(placed(reread, plans.id), placed(before, plans.id));

      const note = unwrap(await get(transport, { target: { id: inside.id } })).entity;

      assert.equal(note.parentId, plans.id);
      assert.equal(note.revision, inside.revision);
      assert.deepEqual(note.body, inside.body);
      assert.equal(await pathOf(endpoint, inside.id), `${PERSONAL.path}/move-outer/plans/inside`);
    });
  });

  it('refuses a collision, a cycle, a wrong parent and a stale revision from either client, changing nothing', async () => {
    await withServer(async ({ endpoint }) => {
      const outer = await created(endpoint, ['area', `${WORK.path}/refuse-a`, '--title', 'A']);
      const inner = await created(endpoint, ['area', `${WORK.path}/refuse-a/b`, '--title', 'B']);
      const project = await created(endpoint, ['project', `${WORK.path}/refuse-p`, '--title', 'P']);
      const note = await created(endpoint, [
        'resource.note',
        `${WORK.path}/taken`,
        '--title',
        'Here',
        '--body-literal',
        'Mine',
      ]);
      const rival = await created(endpoint, [
        'resource.note',
        `${PERSONAL.path}/taken`,
        '--title',
        'There',
        '--body-literal',
        'Theirs',
      ]);
      const transport = createTransport({ endpoint, apiKey: KEY, fetch });
      const refused = async (args, code) => {
        const ran = await runCli(['move', ...args], { endpoint });

        assert.equal(ran.code, 1, `${args.join(' ')} should be refused`);
        assert.match(ran.stderr, new RegExp(`code: ${code}`));

        return ran;
      };

      // A stale revision needs a newer one: an ordinary edit at the terminal makes it.
      await cliJson(['update', '--id', String(note.id), '--title', 'Here, edited'], { endpoint });

      const hierarchyBefore = await hierarchyOver(transport);
      const entitiesBefore = await Promise.all(
        [outer, inner, project, note, rival].map((each) => entityOf(endpoint, each.id)),
      );

      const cycle = await refused(
        [`${WORK.path}/refuse-a`, `${WORK.path}/refuse-a/b`],
        'invalid_parent',
      );

      assert.match(cycle.stderr, /cannot be moved inside itself/);
      await refused([`${WORK.path}/refuse-a`, `${WORK.path}/refuse-p`], 'invalid_parent');
      await refused([`${WORK.path}/taken`, PERSONAL.path], 'slug_conflict');
      await refused(
        [`${WORK.path}/taken`, `${PERSONAL.path}/fresh`, '--revision', String(note.revision)],
        'revision_conflict',
      );

      // No partial write anywhere: every entity and the phone's tree read exactly as before.
      const entitiesAfter = await Promise.all(
        [outer, inner, project, note, rival].map((each) => entityOf(endpoint, each.id)),
      );

      assert.deepEqual(entitiesAfter, entitiesBefore);

      const hierarchyAfter = await hierarchyOver(transport);

      for (const id of hierarchyBefore.byId.keys()) {
        assert.deepEqual(placed(hierarchyAfter, id), placed(hierarchyBefore, id));
      }
      assert.equal(hierarchyAfter.byId.size, hierarchyBefore.byId.size);
    });
  });
});

describe('archive and restore, across the two clients', () => {
  const containerAt = async (endpoint, type, at, title) => {
    const { entity } = await cliJson(['create', type, at, '--title', title], { endpoint });

    return { ...entity, at };
  };

  it('is archived by the terminal and leaves the phone’s hierarchy and Home, keeping its selection', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const project = await containerAt(endpoint, 'project', '/work/shelved', 'Shelved');
      const selected = await runCli(['update', project.at, '--active'], { endpoint });
      assert.equal(selected.code, 0, selected.stderr);
      assert.deepEqual(
        activeProjects(await hierarchyOver(transport)).map((found) => found.slug),
        ['shelved'],
      );

      const archived = await runCli(['archive', project.at], { endpoint });
      assert.equal(archived.code, 0, archived.stderr);
      assert.match(archived.stdout, /^Archived project /);

      const archivedTree = await hierarchyOver(transport);
      assert.equal(archivedTree.byId.has(project.id), false, 'the phone’s tree no longer holds it');
      assert.deepEqual(activeProjects(archivedTree), [], 'and Home no longer lists it');

      // The selection itself was kept: archive hides, it does not deselect.
      const shown = await runCli(['get', project.at], { endpoint });
      assert.match(shown.stdout, /^active: yes$/m);
      assert.match(shown.stdout, /^archived: yes$/m);
    });
  });

  it('is restored by the phone at the revision it read, and the terminal sees it active and selected', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const project = await containerAt(endpoint, 'project', '/work/returning', 'Returning');
      assert.equal((await runCli(['update', project.at, '--active'], { endpoint })).code, 0);
      assert.equal((await runCli(['archive', project.at], { endpoint })).code, 0);

      // What the phone reads is what it writes against: the Get revision, as the design requires.
      const read = unwrap(await get(transport, { target: { id: project.id } })).entity;
      assert.equal(read.archived, true);
      assert.equal(read.active, true);

      const answered = unwrap(
        await restore(transport, { target: { id: read.id }, revision: read.revision }),
      );
      assert.equal(answered.node.archived, false);
      assert.deepEqual(answered.archiveCauses, []);
      assert.equal(answered.node.revision, read.revision + 1);

      const atTerminal = await cliJson(['get', project.at], { endpoint });
      assert.equal(atTerminal.entity.archived, false);
      assert.equal(atTerminal.entity.active, true, 'still selected');
      assert.equal(atTerminal.entity.revision, answered.node.revision);

      const tree = await hierarchyOver(transport);
      assert.equal(tree.byId.get(project.id)?.active, true, 'back in the phone’s tree');
      assert.deepEqual(
        activeProjects(tree).map((found) => found.slug),
        ['returning'],
      );
    });
  });

  it('keeps an independent cause below a restored container (ADR 0003)', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const project = await containerAt(endpoint, 'project', '/work/ten', 'Ten');
      const plain = await cliJson(
        ['create', 'resource.note', '/work/ten/eleven', '--title', 'Eleven'],
        { endpoint },
      );
      const independent = await cliJson(
        ['create', 'resource.note', '/work/ten/twelve', '--title', 'Twelve'],
        { endpoint },
      );

      assert.equal((await runCli(['archive', '/work/ten/twelve'], { endpoint })).code, 0);
      assert.equal((await runCli(['archive', project.at], { endpoint })).code, 0);
      const restored = await runCli(['restore', project.at], { endpoint });
      assert.equal(restored.code, 0, restored.stderr);
      assert.match(restored.stdout, /^Restored project /);

      const read = async (id) => unwrap(await get(transport, { target: { id } })).entity;
      assert.equal((await read(project.id)).archived, false);
      assert.equal((await read(plain.entity.id)).archived, false);
      const kept = await read(independent.entity.id);
      assert.equal(kept.archived, true);
      assert.deepEqual(kept.archiveCauses, [
        {
          origin: { id: independent.entity.id, type: 'resource', title: 'Twelve' },
          owner: 'user',
          reason: 'direct',
        },
      ]);
    });
  });
});

/**
 * One favorite, starred by one client and dropped by the other.
 *
 * The story promises favorites that are server data, shared across clients. The phone side reads
 * through the options its Favorites tab uses and flattens the pages the way the tab does, and it
 * removes with the call `useFavoriteToggle`'s `mutationFn` issues - `removeFavorite(transport, {
 * target: { id } })` through the same `unwrap` - rather than mounting the hook, for the reason the
 * active-selection crossing above gives: the hook's plumbing is pinned against a controllable fake,
 * and nothing in this file is stubbed.
 */
describe('a favorite, across the two clients', () => {
  const favoritesOnPhone = async (transport) => {
    const pages = await allPages(freshClient(), favoritePagesOptions(1, transport));

    return flattenFavoritePages(pages).map((item) => item.node);
  };

  it('is added by the terminal and listed by the phone, and a phone removal leaves the terminal', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const { entity: project } = await cliJson(
        ['create', 'project', `${WORK.path}/starred`, '--title', 'Starred'],
        { endpoint },
      );

      assert.deepEqual(await favoritesOnPhone(transport), [], 'nothing is a favorite yet');

      const added = await runCli(['favorite', `${WORK.path}/starred`], { endpoint });
      assert.equal(added.code, 0, added.stderr);

      const listed = await favoritesOnPhone(transport);
      assert.deepEqual(
        listed.map((node) => [node.id, node.type, node.title, node.isFavorite]),
        [[project.id, 'project', 'Starred', true]],
        'the phone lists what the terminal starred',
      );

      const answer = unwrap(await removeFavorite(transport, { target: { id: project.id } }));
      assert.deepEqual(answer, { nodeId: project.id, isFavorite: false });

      const atTerminal = await cliJson(['favorites'], { endpoint });
      assert.deepEqual(atTerminal.items, [], 'the terminal no longer lists it');
      assert.deepEqual(await favoritesOnPhone(transport), []);
    });
  });
});
