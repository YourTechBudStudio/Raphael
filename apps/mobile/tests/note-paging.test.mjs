/**
 * The traversal, driven against the real query library.
 *
 * The promises this capability makes about paging are promises about how the library behaves under
 * the options it is given: that a second page starts where the server said it ended, that scrolling
 * twice does not fetch the same offset twice, that a failed page leaves the earlier ones alone, and
 * that a refresh is a fresh traversal rather than a re-read of every page still held. None of that
 * can be shown by inspecting the options object, so a real `QueryClient` and a real observer are
 * what run here.
 *
 * No renderer and no server: the transport is a stub that answers with pages, and the *response
 * contract* still decodes every one of them, so a page shape this app could not accept fails here
 * rather than in a screen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { Either } from 'effect';

import {
  notePagesOptions,
  requestNextPage,
  truncateToFirstPage,
} from '../src/modules/resources/client/options.ts';
import {
  containerDescriptor,
  feedDescriptor,
  noteListKey,
} from '../src/modules/resources/client/requests.ts';

/** One server summary for a note. */
const summary = (id, over = {}) => ({
  id,
  type: 'resource',
  kind: 'note',
  parentId: 3,
  slug: `note-${String(id)}`,
  revision: 1,
  title: `Note ${String(id)}`,
  description: '',
  tags: [],
  active: false,
  ...over,
});

/**
 * A transport that answers List from a script, recording what it was asked.
 *
 * `decode` is the contract's own decoder, so nothing here can hand the app a page the real client
 * would have refused.
 */
const stubTransport = (answers) => {
  const requests = [];
  let next = 0;

  return {
    requests,
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: async (call) => {
        requests.push(call.body);
        const answer = answers[next];
        next += 1;

        if (answer === undefined) throw new Error('no scripted answer left');
        if (answer.failure !== undefined) {
          return { ok: false, failure: answer.failure };
        }

        const decoded = call.decode(answer);
        if (Either.isLeft(decoded))
          throw new Error(`stub answer was refused: ${decoded.left.message}`);

        return { ok: true, value: decoded.right };
      },
    },
  };
};

const listAnswer = (ids, over = {}) => ({
  items: ids.map((id) => summary(id)),
  skip: 0,
  limit: 50,
  hasMore: false,
  ...over,
});

const transportFailure = {
  failure: { kind: 'transport', mutationOutcome: 'not_applicable', message: 'offline' },
};

/** A client that does not retry, so a scripted failure is observed as one. */
const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

/** Subscribes an observer and returns a handle that settles when the observer is idle. */
const drive = (client, options) => {
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);

  return {
    observer,
    result: () => observer.getCurrentResult(),
    stop: () => {
      unsubscribe();
    },
  };
};

/** Waits until the observer has stopped fetching, which is when its result is worth asserting on. */
const settle = async (handle) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (handle === undefined) continue;
    const result = handle.result();
    if (result.fetchStatus === 'idle' && !result.isFetching) return;
  }
};

/** Drives the end-of-scroll guard the way a screen does, over the observer's live result. */
const reachEnd = (handle) => {
  const result = handle.result();

  return requestNextPage(
    {
      hasNextPage: result.hasNextPage,
      isFetchingNextPage: result.isFetchingNextPage,
      fetchNextPage: () => handle.observer.fetchNextPage().catch(() => undefined),
    },
    result.isFetchNextPageError,
  );
};

describe('paging a container list', () => {
  it('asks for the next offset the server named, not the number of cards it kept', async () => {
    // Two rows were sent and one is not a note, so one card is drawn. Counting cards would ask for
    // offset one next and re-read a row the server had already handed over.
    //
    // The row that is dropped is a *container*, not an unknown resource kind: the response contract
    // refuses an unsupported kind outright, so a page carrying one never decodes at all. The guard
    // in `toNoteSummaryItem` is the layer behind that, and a container is what can actually reach it.
    const { transport, requests } = stubTransport([
      {
        items: [summary(1), { ...summary(2), type: 'area', kind: null }],
        skip: 0,
        limit: 50,
        hasMore: true,
      },
      listAnswer([3], { skip: 50, limit: 50 }),
    ]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    assert.deepEqual(
      handle.result().data.pages[0].items.map((item) => item.id),
      [1],
      'the unknown kind is dropped rather than drawn as a note',
    );

    await handle.observer.fetchNextPage();
    await settle(handle);
    assert.equal(requests[1].skip, 50);
    assert.deepEqual(
      handle.result().data.pages.flatMap((page) => page.items.map((item) => item.id)),
      [1, 3],
    );
    handle.stop();
  });

  it('stops when the server says there is no more', async () => {
    const { transport } = stubTransport([listAnswer([1])]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    assert.equal(handle.result().hasNextPage, false);
    handle.stop();
  });

  it('does not fetch the same offset twice when the scroll reaches the end repeatedly', async () => {
    const { transport, requests } = stubTransport([
      listAnswer([1], { hasMore: true }),
      listAnswer([2], { skip: 50 }),
    ]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    // Several scroll events in the same frame, which is what a flick actually produces. The guard
    // is load-bearing: the library issues a second request for the same offset if it is asked.
    assert.equal(reachEnd(handle), true);
    assert.equal(reachEnd(handle), false);
    assert.equal(reachEnd(handle), false);
    await settle(handle);

    assert.deepEqual(
      requests.map((request) => request.skip),
      [0, 50],
    );
    handle.stop();
  });

  it('stops asking once a page has failed, rather than re-asking on every scroll', async () => {
    const { transport, requests } = stubTransport([
      listAnswer([1], { hasMore: true }),
      transportFailure,
    ]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    assert.equal(reachEnd(handle), true);
    await settle(handle);

    assert.equal(handle.result().isFetchNextPageError, true);
    assert.equal(reachEnd(handle), false, 'the retry is the pull-down, not the next scroll event');
    assert.equal(requests.length, 2);
    handle.stop();
  });

  it('keeps every earlier row when a next page fails', async () => {
    const { transport } = stubTransport([listAnswer([1, 2], { hasMore: true }), transportFailure]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    await handle.observer.fetchNextPage().catch(() => undefined);
    await settle(handle);

    const result = handle.result();
    assert.deepEqual(
      result.data.pages.flatMap((page) => page.items.map((item) => item.id)),
      [1, 2],
    );
    assert.equal(result.isFetchNextPageError, true);
    handle.stop();
  });
});

describe('pull to refresh', () => {
  it('drops the pages after the first and reads page one again', async () => {
    const { transport, requests } = stubTransport([
      listAnswer([1], { hasMore: true }),
      listAnswer([2], { skip: 50, hasMore: true }),
      listAnswer([9], { hasMore: true }),
    ]);
    const client = freshClient();
    const options = notePagesOptions(1, transport, feedDescriptor, true);
    const handle = drive(client, options);

    await settle(handle);
    await handle.observer.fetchNextPage();
    await settle(handle);
    assert.equal(handle.result().data.pages.length, 2);

    truncateToFirstPage(client, noteListKey(1, feedDescriptor(0)));
    await handle.observer.refetch();
    await settle(handle);

    const result = handle.result();
    // One page, freshly read from offset zero. Page two of a list that has changed describes
    // different rows than it did, so re-reading every held page would splice two readings together.
    assert.equal(result.data.pages.length, 1);
    assert.deepEqual(
      result.data.pages[0].items.map((item) => item.id),
      [9],
    );
    assert.deepEqual(
      requests.map((request) => request.skip),
      [0, 50, 0],
    );
    handle.stop();
  });

  it('leaves the earlier reading on screen when the refresh fails', async () => {
    const { transport } = stubTransport([listAnswer([1], { hasMore: true }), transportFailure]);
    const client = freshClient();
    const handle = drive(client, notePagesOptions(1, transport, feedDescriptor, true));

    await settle(handle);
    truncateToFirstPage(client, noteListKey(1, feedDescriptor(0)));
    await handle.observer.refetch();
    await settle(handle);

    const result = handle.result();
    assert.deepEqual(
      result.data.pages[0].items.map((item) => item.id),
      [1],
      'a failed refresh must not blank a reading that was true',
    );
    assert.equal(result.isError, true);
    assert.equal(result.isFetchNextPageError, false);
    handle.stop();
  });
});

describe('the request that actually goes out', () => {
  it('is the root recursive resource list, newest first, for Home', async () => {
    const { transport, requests } = stubTransport([listAnswer([1])]);
    const client = freshClient();
    const handle = drive(client, notePagesOptions(1, transport, feedDescriptor, true));

    await settle(handle);
    assert.deepEqual(requests[0], {
      scopes: [{ path: '/' }],
      recursive: true,
      filter: { type: 'resource' },
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      skip: 0,
      limit: 50,
    });
    handle.stop();
  });

  it('is the container list in the default order, with no ordering named', async () => {
    const { transport, requests } = stubTransport([listAnswer([1])]);
    const client = freshClient();
    const handle = drive(
      client,
      notePagesOptions(1, transport, (skip) => containerDescriptor(7, skip), true),
    );

    await settle(handle);
    assert.equal('orderBy' in requests[0], false);
    assert.deepEqual(requests[0].scopes, [{ id: 7 }]);
    assert.equal(requests[0].recursive, false);
    handle.stop();
  });
});

describe('two connections', () => {
  it('do not read one another’s pages', async () => {
    const a = stubTransport([listAnswer([1])]);
    const b = stubTransport([listAnswer([2])]);
    const client = freshClient();

    const first = drive(client, notePagesOptions(1, a.transport, feedDescriptor, true));
    const second = drive(client, notePagesOptions(2, b.transport, feedDescriptor, true));
    await settle(first);
    await settle(second);

    assert.deepEqual(
      first.result().data.pages[0].items.map((item) => item.id),
      [1],
    );
    assert.deepEqual(
      second.result().data.pages[0].items.map((item) => item.id),
      [2],
    );
    first.stop();
    second.stop();
  });

  it('asks nothing at all without a transport', async () => {
    const client = freshClient();
    const handle = drive(client, notePagesOptions(-1, null, feedDescriptor, true));

    await settle(handle);
    assert.equal(handle.result().fetchStatus, 'idle');
    assert.equal(handle.result().data, undefined);
    handle.stop();
  });
});
