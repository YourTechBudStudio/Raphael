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

import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { displayableBody } from '../src/modules/resources/client/display.ts';
import { noteEntityOptions, notePagesOptions } from '../src/modules/resources/client/options.ts';
import { containerDescriptor, feedDescriptor } from '../src/modules/resources/client/requests.ts';
import { toNoteSummaryItem } from '../src/modules/resources/client/summary.ts';
import { documentWith, fakeEditor } from './support/capture-harness.mjs';
import {
  captureOver,
  cleanupDirectories,
  cliJson,
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

/** Settle one query through the real observer the screens use, and hand back its result. */
const observe = async (client, options) => {
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    return await observer.refetch().then(() => observer.getCurrentResult());
  } finally {
    unsubscribe();
  }
};

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
      const client = freshClient();
      const { transport } = await captureOver(endpoint, path.join(dir, 'unused.db'));

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

        // The phone's own read, by the phone's own query, asking for the canonical format.
        const read = await observe(client, noteEntityOptions(1, transport, written.id));
        assert.equal(read.status, 'success', `${row.name}: the phone could read it`);

        const entity = read.data;
        assert.equal(entity.id, written.id, `${row.name}: same numeric identity`);
        assert.equal(entity.revision, 1, `${row.name}: same revision`);
        assert.equal(entity.kind, 'note', `${row.name}: same kind`);
        assert.equal(entity.type, 'resource', `${row.name}: same type`);
        assert.equal(entity.parentId, WORK.id, `${row.name}: same parent`);
        assert.equal(entity.slug, row.slug, `${row.name}: same slug`);
        assert.equal(entity.title, row.title, `${row.name}: same title`);
        assert.equal(entity.description, row.description, `${row.name}: same description`);
        assert.equal(entity.body.format, 'tiptap', `${row.name}: the phone reads canonical bodies`);

        // The body the composer would be given is the body the server holds, not a projection of it.
        assert.deepEqual(
          displayableBody(entity),
          entity.body.value,
          `${row.name}: displayable body`,
        );

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
        assert.deepEqual(byPath.entity, entity, `${row.name}: id and path address the same note`);
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
  it('carries its title, description, body, revision, identity and kind across', async () => {
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
