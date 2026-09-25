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
 * **What this is not.** No Expo runtime, no WebView, no `expo-sqlite`: the capture store runs on
 * `node:sqlite` through the shared port. The device run remains Phase 07's human-assisted block.
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
import { get, restore, update } from '@raphael/client/nodes';
import { QueryClient } from '@tanstack/react-query';

import { asClientFailure, unwrap } from '../src/infrastructure/query/failure.ts';
import { unfinishedEdits } from '../src/modules/capture/edit-unfinished.ts';
import { activeProjects } from '../src/modules/collections/client/hierarchy.ts';
import { notePagesOptions } from '../src/modules/resources/client/options.ts';
import { containerDescriptor, feedDescriptor } from '../src/modules/resources/client/requests.ts';
import { toNoteSummaryItem } from '../src/modules/resources/client/summary.ts';
import { documentWith, fakeEditor } from './support/capture-harness.mjs';
import {
  captureOver,
  cleanupDirectories,
  cliJson,
  editOver,
  hierarchyOver,
  KEY,
  runCli,
  temporaryDir,
  withServer,
} from './support/cross-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', 'packages', 'content', 'tests', 'fixtures');

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
 * Wait for a real dispatch to come back.
 *
 * `save` returns as soon as the request is on its way - the whole point of the design is that the
 * answer is a separate event - so a test about what the server did has to wait for the attempt to
 * settle. A wall-clock deadline rather than a fixed number of event-loop turns, because what is
 * being waited on here is an actual HTTP round trip.
 */
const settled = async (owner, what = 'the attempt to settle') => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const attempt = owner.getState().attempts[0];
    if (attempt !== undefined && attempt.state !== 'dispatch_intent') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail(`timed out waiting for ${what}`);
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
      // The phone's own read of one note is the edit owner's Get: opening a note is editing it, so
      // there is no detail query left to ask, and this is the read a person actually makes.
      const phone = await editOver(endpoint, path.join(dir, 'edits.db'));
      await phone.owner.getState().initialize();

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

        // The phone's own read, through the owner that performs it, asking for the canonical format.
        const opened = await phone.owner.getState().open(written.id, phone.session);
        assert.equal(opened.kind, 'ready', `${row.name}: the phone could open it`);
        assert.deepEqual(
          opened.location,
          { kind: 'known', parentId: WORK.id },
          `${row.name}: same parent`,
        );

        const record = phone.record(written.id);
        assert.equal(record.baseRevision, 1, `${row.name}: same revision`);
        assert.equal(record.kind, 'note', `${row.name}: same kind`);
        assert.equal(record.nodeType, 'resource', `${row.name}: same type`);
        assert.equal(record.content.slug, row.slug, `${row.name}: same slug`);
        assert.equal(record.content.title, row.title, `${row.name}: same title`);
        assert.equal(record.content.description, row.description, `${row.name}: same description`);

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
        // A body the composer can open, and it is the server's canonical document rather than a
        // projection of it. The owner refuses a Markdown body outright, so the request it sent must
        // have named `format: 'tiptap'` for the record to exist at all.
        assert.equal(byPath.entity.body.format, 'tiptap', `${row.name}: canonical body`);
        assert.deepEqual(
          record.content.document,
          byPath.entity.body.value,
          `${row.name}: the composer is given the body the server holds`,
        );
      }
    });
  });

  it('puts them all in the phone feed and in their container, through real paging', async () => {
    const dir = await temporaryDir('cli-feed-');

    await withServer(async ({ endpoint }) => {
      const client = freshClient();
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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
    const dir = await temporaryDir('active-cli-writes-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));

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
    const dir = await temporaryDir('active-phone-writes-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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
    const dir = await temporaryDir('active-stale-phone-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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
      assert.equal(refusal.kind, 'api_error');
      assert.equal(refusal.error.code, 'revision_conflict');

      const atTerminal = await cliJson(['get', project.at], { endpoint });
      assert.equal(atTerminal.entity.active, true, 'nothing was undone');
      assert.equal(atTerminal.entity.revision, stale.revision + 1, 'and exactly one write landed');
    });
  });
});

describe('a note the phone wrote, read by the CLI', () => {
  it('carries its title, description, tags, body, revision, identity and kind across', async () => {
    const dir = await temporaryDir('phone-writes-');

    await withServer(async ({ endpoint }) => {
      const { owner, session } = await captureOver(endpoint, path.join(dir, 'capture.db'));
      const editor = fakeEditor();
      const document = documentWith('Written on the phone, read at a terminal');

      try {
        await owner.getState().initialize();
        const draft = await owner.getState().createDraft(session);
        assert.equal(draft.kind, 'created');

        const { draftId } = draft;
        await owner.getState().selectDestination(draftId, { type: 'area', id: WORK.id }, session);
        owner.getState().editDraft(draftId, {
          title: 'From the phone',
          description: 'Typed into the composer',
          // Entered before the note exists, which is what the creation draft now carries and what
          // the frozen request has to take with it.
          tags: ['sync', 'design'],
        });
        owner.getState().attachEditor(draftId, editor.port);
        editor.captures(document);

        const outcome = await owner.getState().save(draftId, session);
        assert.equal(outcome.kind, 'dispatched', 'the save went out');

        const attempt = await settled(owner, 'the server to answer the save');
        assert.equal(attempt.state, 'acknowledged', 'the server accepted it');

        const acknowledged = attempt.acknowledged;
        assert.equal(acknowledged.kind, 'note');

        // The CLI, by id and by path, in both formats.
        const byId = await cliJson(['get', '--id', String(acknowledged.id), '--format', 'tiptap'], {
          endpoint,
        });
        assert.equal(byId.entity.id, acknowledged.id);
        assert.equal(byId.entity.revision, acknowledged.revision);
        assert.equal(byId.entity.kind, 'note');
        assert.equal(byId.entity.type, 'resource');
        assert.equal(byId.entity.parentId, WORK.id);
        assert.equal(byId.entity.title, 'From the phone');
        assert.equal(byId.entity.description, 'Typed into the composer');
        assert.deepEqual(byId.entity.tags, ['sync', 'design'], 'tagged before it existed');
        assert.deepEqual(byId.entity.body.value, document, 'the canonical body crossed unchanged');

        const byPath = await cliJson(
          ['get', `${WORK.path}/${byId.entity.slug}`, '--format', 'tiptap'],
          { endpoint },
        );
        assert.deepEqual(byPath.entity, byId.entity, 'id and path address the same note');

        const asMarkdown = await cliJson(['get', '--id', String(acknowledged.id)], { endpoint });
        assert.equal(asMarkdown.entity.body.value, 'Written on the phone, read at a terminal');

        // And it is listed with its qualified type, which is how a terminal sees it at all.
        const listed = await runCli(['list', WORK.path, '--filter', '{"type":"resource"}'], {
          endpoint,
        });
        assert.equal(listed.code, 0);
        assert.match(listed.stdout, new RegExp(`resource\\.note {2}${byId.entity.slug}`));
      } finally {
        await owner.getState().close();
      }
    });
  });

  it('lets the terminal read a note whose title the server derived from its body', async () => {
    const dir = await temporaryDir('phone-derived-');

    await withServer(async ({ endpoint }) => {
      const { owner, session } = await captureOver(endpoint, path.join(dir, 'capture.db'));
      const editor = fakeEditor();

      try {
        await owner.getState().initialize();
        const draft = await owner.getState().createDraft(session);
        const { draftId } = draft;
        await owner.getState().selectDestination(draftId, { type: 'area', id: WORK.id }, session);
        owner.getState().attachEditor(draftId, editor.port);
        editor.captures(documentWith('A title nobody typed'));

        const outcome = await owner.getState().save(draftId, session);
        assert.equal(outcome.kind, 'dispatched');

        const attempt = await settled(owner, 'the server to answer the save');
        assert.equal(attempt.state, 'acknowledged');

        const acknowledged = attempt.acknowledged;
        assert.equal(acknowledged.title, 'A title nobody typed', 'core named it from the body');

        const got = await cliJson(['get', '--id', String(acknowledged.id)], { endpoint });
        assert.equal(got.entity.title, 'A title nobody typed');
        assert.equal(got.entity.description, '');
      } finally {
        await owner.getState().close();
      }
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
describe('one entity, edited by both clients', () => {
  /** A note to edit, created by the CLI so each case starts from a server-shaped entity. */
  const noteOn = async (endpoint, over = {}) =>
    (
      await cliJson(
        [
          'create',
          'resource.note',
          `${WORK.path}/${over.slug ?? 'shared'}`,
          '--title',
          over.title ?? 'Shared note',
          '--body-literal',
          over.body ?? 'First line',
        ],
        { endpoint },
      )
    ).entity;

  /** Wait for the owner to have nothing outstanding for this entity, or say what it is stuck on. */
  const quiet = async (kit, nodeId, what) => {
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const record = kit.record(nodeId);

      if (record !== null && record.inflightVersion === null) {
        const state = kit.owner.getState();
        const standing = state.standingFor(kit.keyFor(nodeId));

        if (standing !== null && standing.kind !== 'pending' && standing.kind !== 'saving') {
          return standing;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.fail(`timed out waiting for ${what}`);
  };

  it('rebases the phone onto a title the terminal changed', async () => {
    const dir = await temporaryDir('edit-rebase-');

    await withServer(async ({ endpoint }) => {
      const note = await noteOn(endpoint, { slug: 'rebase-me' });
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'));

      try {
        await kit.owner.getState().initialize();
        assert.equal((await kit.owner.getState().open(note.id, kit.session)).kind, 'ready');
        assert.equal(kit.record(note.id).baseRevision, note.revision);

        await cliJson(['update', '--id', String(note.id), '--title', 'Renamed at a terminal'], {
          endpoint,
        });

        // Nothing is unsent, so the next open adopts what the other client wrote.
        assert.equal((await kit.owner.getState().open(note.id, kit.session)).kind, 'ready');

        const record = kit.record(note.id);

        assert.equal(record.base.title, 'Renamed at a terminal');
        assert.equal(record.content.title, 'Renamed at a terminal');
        assert.equal(record.baseRevision, note.revision + 1);
      } finally {
        await kit.owner.getState().close();
      }
    });
  });

  it('puts a body the phone autosaved on the server, canonically, one revision on', async () => {
    const dir = await temporaryDir('edit-body-');

    await withServer(async ({ endpoint }) => {
      const note = await noteOn(endpoint, { slug: 'autosaved-body' });
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'));
      const editor = fakeEditor();

      try {
        await kit.owner.getState().initialize();
        const outcome = await kit.owner.getState().open(note.id, kit.session);
        assert.equal(outcome.kind, 'ready');
        kit.owner.getState().attachEditor(outcome.editKey, editor.port);

        const document = documentWith('Typed into the phone');
        editor.captures(document);
        const flushed = await kit.owner.getState().flush(outcome.editKey, { lock: true });
        assert.equal(flushed.kind, 'flushed');

        await quiet(kit, note.id, 'the body to reach the server');

        const got = await cliJson(['get', '--id', String(note.id), '--format', 'tiptap'], {
          endpoint,
        });

        assert.deepEqual(got.entity.body.value, document, 'the canonical body crossed unchanged');
        assert.equal(got.entity.revision, note.revision + 1, 'one write, one revision');
        assert.equal(kit.record(note.id).baseRevision, got.entity.revision);
      } finally {
        await kit.owner.getState().close();
      }
    });
  });

  it('refuses the phone once and stops, when the terminal wrote while it was unsent', async () => {
    const dir = await temporaryDir('edit-conflict-');

    await withServer(async ({ endpoint }) => {
      const note = await noteOn(endpoint, { slug: 'conflicted' });
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'), {
        // Held off, so the phone genuinely has unsent writing when the terminal writes.
        autosaveDelayMs: 5_000,
      });

      try {
        await kit.owner.getState().initialize();
        const outcome = await kit.owner.getState().open(note.id, kit.session);
        assert.equal(outcome.kind, 'ready');

        kit.owner.getState().editFields(outcome.editKey, { title: 'Typed on the phone' });
        await cliJson(['update', '--id', String(note.id), '--title', 'Typed at a terminal'], {
          endpoint,
        });

        // Leaving dispatches at once rather than waiting out the debounce, and waits for the answer.
        assert.equal(await kit.owner.getState().leave(outcome.editKey), 'kept');

        const standing = kit.owner.getState().standingFor(outcome.editKey);
        assert.deepEqual(standing, { kind: 'conflicted' });

        const record = kit.record(note.id);
        assert.equal(record.content.title, 'Typed on the phone', 'the writing is kept');

        const listed = unfinishedEdits({
          edits: kit.owner.getState().edits,
          unusableEdits: kit.owner.getState().unusableEdits,
          standingFor: kit.owner.getState().standingFor,
          connectionId: kit.session.connectionId,
        });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].standing, 'conflicted');

        const got = await cliJson(['get', '--id', String(note.id)], { endpoint });
        assert.equal(got.entity.title, 'Typed at a terminal', 'and nothing was overwritten');
        assert.equal(got.entity.revision, note.revision + 1, 'exactly one write landed');

        // Nothing further is attempted, however long it is left.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const left = await cliJson(['get', '--id', String(note.id)], { endpoint });
        assert.equal(left.entity.revision, note.revision + 1);
      } finally {
        await kit.owner.getState().close();
      }
    });
  });

  it('refuses a stale --revision at the terminal, and changes nothing', async () => {
    const dir = await temporaryDir('edit-stale-cli-');

    await withServer(async ({ endpoint }) => {
      const note = await noteOn(endpoint, { slug: 'stale-cli' });
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'), {
        autosaveDelayMs: 5_000,
      });

      try {
        await kit.owner.getState().initialize();
        const outcome = await kit.owner.getState().open(note.id, kit.session);
        assert.equal(outcome.kind, 'ready');
        kit.owner.getState().editFields(outcome.editKey, { title: 'Unsent on the phone' });

        // The phone's writing has not been sent, so the server is still at the note's own revision
        // and this stale one names a version that never existed.
        const ran = await runCli(
          [
            'update',
            '--id',
            String(note.id),
            '--title',
            'From a stale reading',
            '--revision',
            String(note.revision + 5),
          ],
          { endpoint },
        );

        assert.equal(ran.code, 1);

        const got = await cliJson(['get', '--id', String(note.id)], { endpoint });
        assert.equal(got.entity.title, 'Shared note', 'the entity is untouched');
        assert.equal(got.entity.revision, note.revision, 'and so is its revision');
      } finally {
        await kit.owner.getState().close();
      }
    });
  });

  /**
   * A measurement, not a guarantee.
   *
   * Phase 05 recorded that `matchesSubmitted` compares a **carried** body by exact serialized
   * equality, so a lost answer to a body update the server canonicalized reconciles as a conflict
   * rather than as applied - and handed the lever forward on the assumption something here would
   * exercise it. The four cases above never would: none of them loses a body answer.
   *
   * A paragraph ending in a hard break is the cleanest case, because `hard-breaks.ts` drops exactly
   * that break on the way into storage, so the server's stored document legitimately differs from
   * what was sent. The rule is deliberately not changed here - calling the shared canonicalizer from
   * the owner overturns an architecture decision this phase has no mandate for - so this records the
   * observed outcome and nothing else.
   */
  it('measures what a lost answer to a body the server canonicalized concludes', async () => {
    const dir = await temporaryDir('edit-lost-body-');
    let dropNext = false;

    await withServer(async ({ endpoint }) => {
      const note = await noteOn(endpoint, { slug: 'lost-body' });
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'), {
        // The answer is dropped *after* the server has finished writing, so the entity genuinely
        // holds the change and the phone genuinely does not know it.
        fetch: async (input, init) => {
          const response = await fetch(input, init);

          if (dropNext && String(input).includes('/api/nodes/update')) {
            dropNext = false;
            throw new TypeError('fetch failed');
          }

          return response;
        },
      });
      const editor = fakeEditor();

      try {
        await kit.owner.getState().initialize();
        const outcome = await kit.owner.getState().open(note.id, kit.session);
        assert.equal(outcome.kind, 'ready');
        kit.owner.getState().attachEditor(outcome.editKey, editor.port);

        dropNext = true;
        editor.captures({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'ends in a break' }, { type: 'hardBreak' }],
            },
          ],
        });
        assert.equal(
          (await kit.owner.getState().flush(outcome.editKey, { lock: true })).kind,
          'flushed',
        );

        const standing = await quiet(kit, note.id, 'the lost answer to be reconciled');

        const got = await cliJson(['get', '--id', String(note.id), '--format', 'tiptap'], {
          endpoint,
        });

        assert.equal(got.entity.revision, note.revision + 1, 'the write did land');
        assert.deepEqual(
          got.entity.body.value.content[0].content,
          [{ type: 'text', text: 'ends in a break' }],
          'and the server dropped the trailing break, as `hard-breaks.ts` says it does',
        );

        // The measurement. `conflicted` is the known residual window; `synced` would mean the
        // comparison recognized the canonicalized form, which today it does not.
        assert.equal(
          standing.kind,
          'conflicted',
          'a lost answer to a canonicalized body still reconciles as a conflict',
        );
      } finally {
        await kit.owner.getState().close();
      }
    });
  });
});

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

  it('moves a note from the phone, keeping its ID, and the terminal finds it at the new address', async () => {
    const dir = await temporaryDir('move-phone-');

    await withServer(async ({ endpoint }) => {
      const note = await created(endpoint, [
        'resource.note',
        `${WORK.path}/moved-by-phone`,
        '--title',
        'Moved by the phone',
        '--body-literal',
        'Stays exactly as it is',
      ]);
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'));
      const key = kit.keyFor(note.id);

      try {
        await kit.owner.getState().initialize();
        assert.equal((await kit.owner.getState().open(note.id, kit.session)).kind, 'ready');
        // Attached as the edit screen attaches it, so the record outlives the acknowledgement.
        kit.owner.getState().attachEditor(key, fakeEditor().port);
        assert.deepEqual(kit.owner.getState().locations[key], { kind: 'known', parentId: WORK.id });

        const outcome = await kit.owner.getState().move(key, { parentId: PERSONAL.id });

        assert.deepEqual(outcome, { kind: 'moved', parentId: PERSONAL.id });
        // The owner advanced its own location and revision on the server's word, and cleared the move.
        assert.deepEqual(kit.owner.getState().locations[key], {
          kind: 'known',
          parentId: PERSONAL.id,
        });
        assert.equal(kit.record(note.id).baseRevision, note.revision + 1);
        assert.equal(kit.record(note.id).inflight, null);
        assert.equal(kit.record(note.id).content.slug, 'moved-by-phone');

        // The terminal: same identity, same slug, same body, one revision on, at the new address.
        assert.equal(await pathOf(endpoint, note.id), `${PERSONAL.path}/moved-by-phone`);

        const moved = await entityOf(endpoint, note.id);

        assert.equal(moved.id, note.id);
        assert.equal(moved.parentId, PERSONAL.id);
        assert.equal(moved.slug, note.slug);
        assert.equal(moved.revision, note.revision + 1);
        assert.deepEqual(moved.body, note.body);
        assert.equal(moved.title, note.title);

        const old = await runCli(['get', `${WORK.path}/moved-by-phone`], { endpoint });

        assert.equal(old.code, 1);
        assert.match(old.stderr, /node_not_found/);
      } finally {
        await kit.owner.getState().close();
      }
    });
  });

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
    const dir = await temporaryDir('move-refused-');

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

      assert.match(cycle.stderr, /reason: cycle/);
      await refused([`${WORK.path}/refuse-a`, `${WORK.path}/refuse-p`], 'invalid_parent');
      await refused([`${WORK.path}/taken`, PERSONAL.path], 'slug_conflict');
      await refused(
        [`${WORK.path}/taken`, `${PERSONAL.path}/fresh`, '--revision', String(note.revision)],
        'revision_conflict',
      );

      // The phone meets the same collision through its owner: refused, and nothing local moves.
      const kit = await editOver(endpoint, path.join(dir, 'capture.db'));
      const key = kit.keyFor(note.id);

      try {
        await kit.owner.getState().initialize();
        assert.equal((await kit.owner.getState().open(note.id, kit.session)).kind, 'ready');

        const revision = kit.record(note.id).baseRevision;
        const outcome = await kit.owner.getState().move(key, { parentId: PERSONAL.id });

        assert.equal(outcome.kind, 'refused');
        assert.equal(outcome.failure.error.code, 'slug_conflict');
        assert.deepEqual(kit.owner.getState().locations[key], { kind: 'known', parentId: WORK.id });
        assert.equal(kit.record(note.id).baseRevision, revision);
        assert.equal(kit.record(note.id).inflight, null);
      } finally {
        await kit.owner.getState().close();
      }

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
    const dir = await temporaryDir('archive-cli-writes-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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
    const dir = await temporaryDir('archive-phone-restores-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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
    const dir = await temporaryDir('archive-independent-');

    await withServer(async ({ endpoint }) => {
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));
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

  it('moves a note archived only through its project somewhere active, from the phone’s editor', async () => {
    const dir = await temporaryDir('archive-move-out-');

    await withServer(async ({ endpoint }) => {
      const shelved = await containerAt(endpoint, 'project', '/work/shelf', 'Shelf');
      const destination = await containerAt(endpoint, 'project', '/work/desk', 'Desk');
      const { entity: note } = await cliJson(
        ['create', 'resource.note', '/work/shelf/runbook', '--title', 'Runbook'],
        { endpoint },
      );

      assert.equal((await runCli(['archive', shelved.at], { endpoint })).code, 0);

      const kit = await editOver(endpoint, path.join(dir, 'capture.db'));

      try {
        await kit.owner.getState().initialize();

        const outcome = await kit.owner.getState().open(note.id, kit.session);

        assert.equal(outcome.kind, 'ready');
        assert.deepEqual(outcome.lifecycle, {
          kind: 'known',
          archiveCauses: [
            {
              origin: { id: shelved.id, type: 'project', title: 'Shelf' },
              owner: 'user',
              reason: 'direct',
            },
          ],
        });
        kit.owner.getState().attachEditor(outcome.editKey, fakeEditor().port);

        const moved = await kit.owner
          .getState()
          .move(outcome.editKey, { parentId: destination.id });

        assert.deepEqual(moved, { kind: 'moved', parentId: destination.id });
        assert.deepEqual(kit.owner.getState().lifecycles[outcome.editKey], {
          kind: 'known',
          archiveCauses: [],
        });
        assert.deepEqual(kit.refreshed, [kit.session.activation], 'every read is refreshed');

        const atTerminal = await cliJson(['get', '--id', String(note.id)], { endpoint });

        assert.equal(atTerminal.entity.archived, false, 'active at its new parent');
        assert.deepEqual(atTerminal.entity.archiveCauses, []);
        assert.equal(atTerminal.entity.parentId, destination.id);
      } finally {
        await kit.owner.getState().close();
      }
    });
  });
});
