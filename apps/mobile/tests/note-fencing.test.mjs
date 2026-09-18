/**
 * A read that comes back after the connection has changed.
 *
 * Activation separation at rest — two keys that differ — shows that two connections *can* be told
 * apart. It does not show that a reply still in the air when someone switches servers cannot land in
 * the view they are now looking at, and that is the failure that matters: two servers can mint the
 * same numeric id, so a late page or a late entity arriving in the live key would show one server's
 * notes under the other's areas with nothing on screen saying so.
 *
 * So the race is made to happen. A request is started under one activation, a second connection
 * becomes the live one and answers, and only then does the first reply arrive.
 *
 * **Cancellation is deliberately not part of the mechanism here.** The transports below never abort,
 * and every request runs to completion. Cancelling a retired read saves work and is worth doing, but
 * it cannot be the thing correctness rests on: a request can always complete in the window before
 * anyone knows to cancel it. The fence is that the key it resolves into carries the activation it
 * was issued under, so a late answer lands somewhere nothing is reading.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { Either } from 'effect';

import { notePagesOptions } from '../src/modules/resources/client/options.ts';
import { feedDescriptor, noteListKey } from '../src/modules/resources/client/requests.ts';

const summary = (id) => ({
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
});

const listAnswer = (ids) => ({ items: ids.map(summary), skip: 0, limit: 50, hasMore: false });

/**
 * A transport that answers only when the test says so, and records that it was the one asked.
 *
 * It never aborts. `signal` is ignored on purpose: this is the case where cancellation did not
 * happen or did not arrive in time, which is the case the fence has to survive.
 */
const deferredTransport = (name, calls) => {
  const waiting = [];

  return {
    name,
    inFlight: () => waiting.length,
    settle: (answer) => {
      const next = waiting.shift();
      if (next === undefined) throw new Error(`${name} had nothing in flight`);
      next(answer);
    },
    transport: {
      endpoint: { origin: 'https://example.invalid', basePath: '' },
      timeoutMs: 1000,
      invoke: (call) =>
        new Promise((resolve, reject) => {
          calls.push({ transport: name, body: call.body });
          waiting.push((answer) => {
            const decoded = call.decode(answer);
            if (Either.isLeft(decoded)) {
              reject(new Error(`${name} answered with something the contract refused`));

              return;
            }
            resolve({ ok: true, value: decoded.right });
          });
        }),
    },
  };
};

const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

const drive = (client, options) => {
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);

  return { observer, result: () => observer.getCurrentResult(), stop: () => unsubscribe() };
};

const tick = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const idsOf = (result) => result.data.pages.flatMap((page) => page.items).map((item) => item.id);

describe('a page that completes after the connection changed', () => {
  it('lands in the retired key and leaves the live feed exactly as it was', async () => {
    const calls = [];
    const retiredServer = deferredTransport('retired', calls);
    const liveServer = deferredTransport('live', calls);
    const client = freshClient();

    // Activation 1 asks Home for its first page, and the answer is still in the air.
    const retiredRead = client.fetchInfiniteQuery(
      notePagesOptions(1, retiredServer.transport, feedDescriptor, true),
    );
    await tick();
    assert.equal(retiredServer.inFlight(), 1);

    // The connection changes. Activation 2 is what someone is now looking at, and it answers.
    const live = drive(client, notePagesOptions(2, liveServer.transport, feedDescriptor, true));
    await tick();
    liveServer.settle(listAnswer([7]));
    await tick();
    assert.deepEqual(idsOf(live.result()), [7]);

    // Only now does the first server reply — nothing cancelled it, and it completes normally.
    retiredServer.settle(listAnswer([99]));
    await retiredRead;
    await tick();

    // The late answer is stored, and it is stored under the activation it was asked under.
    assert.deepEqual(idsOf({ data: client.getQueryData(noteListKey(1, feedDescriptor(0))) }), [99]);

    // The live feed is untouched: not appended to, not replaced, not re-ordered.
    assert.deepEqual(idsOf({ data: client.getQueryData(noteListKey(2, feedDescriptor(0))) }), [7]);
    assert.deepEqual(idsOf(live.result()), [7]);

    live.stop();
    client.clear();
  });

  it('was served by the transport its options were built with, not the live one', async () => {
    const calls = [];
    const retiredServer = deferredTransport('retired', calls);
    const liveServer = deferredTransport('live', calls);
    const client = freshClient();

    const retiredRead = client.fetchInfiniteQuery(
      notePagesOptions(1, retiredServer.transport, feedDescriptor, true),
    );
    await tick();

    const live = drive(client, notePagesOptions(2, liveServer.transport, feedDescriptor, true));
    await tick();
    liveServer.settle(listAnswer([7]));
    await tick();

    retiredServer.settle(listAnswer([99]));
    await retiredRead;

    // The transport is captured when the options are built, so there is nowhere for an in-flight
    // read to look up a newer one. A read issued against one server stays a read against it.
    assert.deepEqual(
      calls.map((call) => call.transport),
      ['retired', 'live'],
    );

    live.stop();
    client.clear();
  });
});
