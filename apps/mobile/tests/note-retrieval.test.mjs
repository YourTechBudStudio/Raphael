/**
 * Notes created on a real server, read back through the real mobile queries.
 *
 * Everything else about this feed is tested against stubs, which is the right way to pin the six
 * states and the paging guards but proves nothing about whether the server accepts the question this
 * app asks. This does: a real backend on a real database, notes created through the same client the
 * CLI uses, and then Home's traversal, a container's traversal and the detail read driven against it
 * with no substitutes in between.
 *
 * **What this is not.** It is not device evidence. There is no WebView here, no Expo runtime and no
 * `expo-sqlite`; what it shows is that the request, the ordering, the pagination and the entity read
 * are the ones the server answers. The ordinary paths on a phone remain Phase 07's.
 *
 * The listener, the database and the temporary directory are torn down before the test returns,
 * including when an assertion fails.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ApiCredential, CONFIG_DEFAULTS, serve, silentLogger } from '@raphael/backend';
import { createTransport } from '@raphael/client';
import { create as createNode, get as getNode } from '@raphael/client/nodes';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { Effect, Exit, Scope } from 'effect';

import { displayableBody, readFailureReason } from '../src/modules/resources/client/display.ts';
import {
  noteEntityOptions,
  notePagesOptions,
  truncateToFirstPage,
} from '../src/modules/resources/client/options.ts';
import {
  containerDescriptor,
  feedDescriptor,
  noteListKey,
} from '../src/modules/resources/client/requests.ts';
import { toNoteSummaryItem } from '../src/modules/resources/client/summary.ts';

const KEY = `test-${'r'.repeat(40)}`;
const temporaries = [];

after(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A real server on a real database, on whatever port the operating system hands out. */
const withServer = async (body) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'raphael-notes-'));
  temporaries.push(dir);
  const scope = Effect.runSync(Scope.make());

  try {
    const running = await Effect.runPromise(
      Scope.extend(
        serve({
          options: {
            server: { host: '127.0.0.1', port: 0 },
            database: {
              databasePath: path.join(dir, 'raphael.db'),
              busyTimeoutMs: CONFIG_DEFAULTS.busyTimeoutMs,
            },
            idempotency: {
              gcIntervalMinutes: CONFIG_DEFAULTS.gcIntervalMinutes,
              gcBatchSize: CONFIG_DEFAULTS.gcBatchSize,
            },
          },
          credential: ApiCredential.fromKey(KEY),
          logger: silentLogger,
        }),
        scope,
      ),
    );

    const transport = createTransport({
      endpoint: `http://${running.host}:${String(running.port)}`,
      apiKey: KEY,
      fetch,
    });

    return await body(transport);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

const unwrap = (result) => {
  if (!result.ok) throw new Error(`the server refused: ${result.failure.message}`);

  return result.value;
};

let keys = 0;
const nextKey = () => {
  keys += 1;

  return `note-retrieval-${String(keys)}-${'k'.repeat(30)}`;
};

const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const makeArea = async (transport, title) =>
  unwrap(
    await createNode(transport, {
      type: 'area',
      parent: { path: '/' },
      title,
      idempotencyKey: nextKey(),
    }),
  ).entity;

const makeNote = async (transport, parentId, title, text) =>
  unwrap(
    await createNode(transport, {
      type: 'resource',
      kind: 'note',
      parent: { id: parentId },
      title,
      body: { format: 'tiptap', value: doc(text) },
      idempotencyKey: nextKey(),
    }),
  ).entity;

/** A client that does not retry, so a real failure is observed as one. */
const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

const drive = (client, options) => {
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);

  return { observer, result: () => observer.getCurrentResult(), stop: () => unsubscribe() };
};

const settle = async (handle) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const result = handle.result();
    if (result.fetchStatus === 'idle' && !result.isFetching) return;
  }
};

const idsOf = (handle) =>
  handle
    .result()
    .data.pages.flatMap((page) => page.items)
    .map((item) => item.id);

describe('notes on a real server, read back by the real queries', () => {
  it('appear in Home’s feed, newest server edit first, from everywhere', async () => {
    await withServer(async (transport) => {
      const kitchen = await makeArea(transport, 'Kitchen');
      const garden = await makeArea(transport, 'Garden');
      const first = await makeNote(transport, kitchen.id, 'Tiles', 'the grey ones');
      const second = await makeNote(transport, garden.id, 'Bulbs', 'plant in October');
      const third = await makeNote(transport, kitchen.id, 'Taps', 'measure the gap');

      const client = freshClient();
      const handle = drive(client, notePagesOptions(1, transport, feedDescriptor, true));
      await settle(handle);

      // Recursive from the root, so a note in either area is here. Newest first, with the id
      // tie-breaker core appends - this app names no id clause of its own.
      assert.deepEqual(idsOf(handle), [third.id, second.id, first.id]);
      handle.stop();
    });
  });

  it('carry what a card shows, and no body', async () => {
    await withServer(async (transport) => {
      const area = await makeArea(transport, 'Kitchen');
      const note = await makeNote(transport, area.id, 'Tiles', 'the grey ones');

      const client = freshClient();
      const handle = drive(client, notePagesOptions(1, transport, feedDescriptor, true));
      await settle(handle);

      const [card] = handle.result().data.pages[0].items;
      assert.deepEqual(card, {
        id: note.id,
        title: 'Tiles',
        description: '',
        slug: note.slug,
        revision: note.revision,
        parentId: area.id,
      });
      // A summary has no body and no timestamp, which is why no card fetches one and why nothing
      // on a card can claim when it was last touched.
      assert.equal('body' in card, false);
      assert.equal('updatedAt' in card, false);
      handle.stop();
    });
  });

  it('appear in their own container’s list, and not in a sibling’s', async () => {
    await withServer(async (transport) => {
      const kitchen = await makeArea(transport, 'Kitchen');
      const garden = await makeArea(transport, 'Garden');
      const tiles = await makeNote(transport, kitchen.id, 'Tiles', 'the grey ones');
      await makeNote(transport, garden.id, 'Bulbs', 'plant in October');

      const client = freshClient();
      const here = drive(
        client,
        notePagesOptions(1, transport, (skip) => containerDescriptor(kitchen.id, skip), true),
      );
      await settle(here);

      assert.deepEqual(idsOf(here), [tiles.id]);
      here.stop();
    });
  });

  it('do not turn a container list into a list of containers', async () => {
    await withServer(async (transport) => {
      const kitchen = await makeArea(transport, 'Kitchen');
      // A subarea is a child of the same parent and would arrive in an unfiltered list. The request
      // asks for resources, and the guard refuses anything that is not a note besides.
      unwrap(
        await createNode(transport, {
          type: 'area',
          parent: { id: kitchen.id },
          title: 'Splashback',
          idempotencyKey: nextKey(),
        }),
      );
      const tiles = await makeNote(transport, kitchen.id, 'Tiles', 'the grey ones');

      const client = freshClient();
      const handle = drive(
        client,
        notePagesOptions(1, transport, (skip) => containerDescriptor(kitchen.id, skip), true),
      );
      await settle(handle);

      assert.deepEqual(idsOf(handle), [tiles.id]);
      handle.stop();
    });
  });

  it('page on demand, and a refresh starts the traversal again', async () => {
    await withServer(async (transport) => {
      const area = await makeArea(transport, 'Kitchen');
      const created = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(await makeNote(transport, area.id, `Note ${String(index)}`, 'body'));
      }

      // A page size of two, so paging is exercised without creating a hundred notes.
      const twoAtATime = (skip) => ({ ...containerDescriptor(area.id, skip), limit: 2 });
      const client = freshClient();
      const handle = drive(client, notePagesOptions(1, transport, twoAtATime, true));
      await settle(handle);

      assert.equal(handle.result().data.pages.length, 1);
      assert.equal(idsOf(handle).length, 2);

      await handle.observer.fetchNextPage();
      await settle(handle);
      assert.equal(idsOf(handle).length, 4);
      assert.equal(handle.result().hasNextPage, true);

      await handle.observer.fetchNextPage();
      await settle(handle);
      assert.equal(idsOf(handle).length, 5);
      assert.equal(handle.result().hasNextPage, false, 'the server said the list has ended');

      // Every note is here exactly once: the offsets walked forward and never re-read a row.
      assert.deepEqual([...new Set(idsOf(handle))].length, 5);

      truncateToFirstPage(client, noteListKey(1, twoAtATime(0)));
      await handle.observer.refetch();
      await settle(handle);
      assert.equal(handle.result().data.pages.length, 1, 'a refresh is one page, freshly read');
      handle.stop();
    });
  });

  it('open through the app\u2019s own read, with a document the editor accepts', async () => {
    await withServer(async (transport) => {
      const area = await makeArea(transport, 'Kitchen');
      const note = await makeNote(transport, area.id, 'Tiles', 'the grey ones');

      // The capability's own query, not a request written here. A test that issued its own Get
      // would prove the server works and say nothing about what this app asks it.
      const client = freshClient();
      const entity = await client.fetchQuery(noteEntityOptions(1, transport, note.id));

      assert.deepEqual(displayableBody(entity), doc('the grey ones'));
      assert.equal(entity.body.format, 'tiptap');
      assert.equal(entity.revision, 1);
      assert.equal(entity.parentId, area.id);
      client.clear();
    });
  });

  it('are refused by presentation when the answer is Markdown, never converted', async () => {
    await withServer(async (transport) => {
      const area = await makeArea(transport, 'Kitchen');
      const note = await makeNote(transport, area.id, 'Tiles', 'the grey ones');

      // What the server returns when `format` is omitted, which is what dropping that field from
      // `noteEntityOptions` would produce. Perfectly valid, perfectly readable, and refused here -
      // converting it would make this client a second content authority beside `@raphael/content`.
      const markdown = unwrap(await getNode(transport, { target: { id: note.id } })).entity;

      assert.equal(markdown.body.format, 'markdown');
      assert.equal(displayableBody(markdown), null);
    });
  });

  it('read as missing, not as an unreachable server, when there is no such note', async () => {
    await withServer(async (transport) => {
      await makeArea(transport, 'Kitchen');

      // The ordinary case: a card opened from a list read before the note was deleted. Asserted
      // against a real 404 envelope, because `isNotFound` is deliberately narrow - only a
      // well-formed Raphael error counts - and a hand-built failure could not show that this
      // server's answer is one.
      const client = freshClient();
      const failure = await client
        .fetchQuery(noteEntityOptions(1, transport, 999_999))
        .then(() => null)
        .catch((error) => error);

      assert.notEqual(failure, null, 'the server answered, and the answer was a refusal');
      assert.equal(readFailureReason(failure), 'missing');
      client.clear();
    });
  });

  it('are not opened when the server answers with a container', async () => {
    await withServer(async (transport) => {
      const area = await makeArea(transport, 'Kitchen');
      const client = freshClient();
      const entity = await client.fetchQuery(noteEntityOptions(1, transport, area.id));

      // Reachable by a stale link to a container id. There is no editor for it and no pretending
      // there is one.
      assert.equal(displayableBody(entity), null);
      assert.equal(toNoteSummaryItem(entity), null);
      client.clear();
    });
  });
});
