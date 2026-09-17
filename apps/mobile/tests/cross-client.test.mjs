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

import { QueryClient } from '@tanstack/react-query';

import { unfinishedEdits } from '../src/modules/capture/edit-unfinished.ts';
import { notePagesOptions } from '../src/modules/resources/client/options.ts';
import { containerDescriptor, feedDescriptor } from '../src/modules/resources/client/requests.ts';
import { toNoteSummaryItem } from '../src/modules/resources/client/summary.ts';
import { documentWith, fakeEditor } from './support/capture-harness.mjs';
import {
  captureOver,
  cleanupDirectories,
  cliJson,
  editOver,
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
        notePagesOptions(1, transport, (skip) => containerDescriptor(WORK.id, skip), true),
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
        }),
        null,
        'a container is never mapped into a notes grid',
      );
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
        const listed = await runCli(['list', WORK.path, '--types', 'resource'], { endpoint });
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
