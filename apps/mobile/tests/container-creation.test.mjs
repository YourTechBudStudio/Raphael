/**
 * Creating an area or a project, now that it is a plain request.
 *
 * The durable attempt subsystem is gone, so the properties worth pinning are the ones the session
 * replaces it with: **one request per press**, **one key per opening**, and three honest outcomes.
 * The key is what makes the cheap case safe - a press, a lost answer, another press while the form
 * is open is a replay rather than a second area - and forgetting it on close is the accepted cost.
 *
 * The client is real and the transport is real; only `fetch` is substituted, so the request that
 * goes out is the one the app would actually send and the key is read back off the wire rather than
 * asserted about a fake.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.teardown());

const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createTransport } = await import('@raphael/client');
const { useContainerCreationSession } =
  await import('../src/modules/collections/client/container-creation.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');
const { ARCHIVED_PARENT_CREATION_SENTENCE } = await import('../src/modules/lifecycle/copy.ts');

/** Wait for something the transport is doing, rather than counting awaits in the implementation. */
const until = async (condition, what) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  assert.fail(`timed out waiting for ${what}`);
};
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');

// Clearing the cache is what lets this file's process exit rather than idle on a collection timer.
after(() => {
  queryClient.clear();
});

const KEY = `test-${'k'.repeat(40)}`;
const ENDPOINT = 'https://raphael.example';

const entity = (over = {}) => ({
  id: 5,
  type: 'area',
  kind: null,
  parentId: null,
  slug: 'reading',
  revision: 1,
  title: 'Reading',
  description: '',
  tags: [],
  active: false,
  archived: false,
  archiveCauses: [],
  body: { format: 'markdown', value: '' },
  metadata: {},
  ...over,
});

/** A fetch that records what went out and answers with whatever the test queued. */
const recordingFetch = (queue, sent) => async (_url, init) => {
  sent.push(JSON.parse(init.body));

  const next = queue.shift();

  assert.ok(next !== undefined, 'the test did not queue a response for this request');

  if (next === 'lost') throw new TypeError('Network request failed');

  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
};

const activate = (transport, activation) => {
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation,
        transport,
        connection: {
          connectionId: 'c1',
          base: ENDPOINT,
          origin: ENDPOINT,
          protocolVersion: 1,
        },
      },
    },
  });
};

/** Renders the hook and hands the test its `submit`, one opening at a time. */
const mount = () => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const handle = { submit: null, busy: false, reopen: null };

  function Probe() {
    const [sessionId, setSessionId] = useState(1);
    const session = useContainerCreationSession(sessionId);

    handle.submit = session.submit;
    handle.busy = session.busy;
    handle.reopen = () => {
      setSessionId((current) => current + 1);
    };

    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  return {
    ...handle,
    /** Read fresh: the probe replaces the callbacks on every render. */
    send: async (input) => {
      let outcome;

      await act(async () => {
        outcome = await handle.submit(input);
      });

      return outcome;
    },
    /**
     * Two presses in the same synchronous turn, as a double tap is.
     *
     * The `act` scope is synchronous and returns nothing: an async one would hold until both
     * settle, and the first is deliberately still in the air when the test wants to look at it.
     */
    sendTwice: (input) => {
      // Deliberately outside `act`: the two calls have to happen in one turn with the first still
      // in the air, and an `act` scope would either hold until both settle or close around a
      // pending one. The state updates they cause are settled by the `act` the caller awaits after.
      const first = handle.submit(input);
      const second = handle.submit(input);

      return Promise.all([first, second]);
    },
    reopen: () => {
      act(() => {
        handle.reopen();
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

const sessionOver = (queue) => {
  const sent = [];
  const transport = createTransport({
    endpoint: ENDPOINT,
    apiKey: KEY,
    fetch: recordingFetch(queue, sent),
  });

  activate(transport, 1);

  return { sent, form: mount() };
};

describe('one opening of the creation form', () => {
  it('sends one request, and reuses its key for a second press', async () => {
    const queue = ['lost', { status: 201, body: { entity: entity() } }];
    const { sent, form } = sessionOver(queue);

    try {
      const lost = await form.send({ containerType: 'area', parentAreaId: null, title: 'Reading' });

      // A lost answer is not a failure and is never retried on its own. What it needs is looking.
      assert.equal(lost.kind, 'unconfirmed');
      assert.ok(lost.message.includes('Look for it'));
      assert.equal(sent.length, 1);

      const again = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      assert.equal(again.kind, 'created');
      assert.deepEqual(again.container, { type: 'area', id: 5 });
      assert.equal(sent.length, 2);
      // The same key, so the server's own replay protection covers the second press. Without it
      // this is how one lost answer becomes two areas.
      assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
      assert.ok(typeof sent[0].idempotencyKey === 'string' && sent[0].idempotencyKey !== '');
    } finally {
      form.unmount();
    }
  });

  it('keeps the title after a refusal, under the same key', async () => {
    const queue = [
      {
        status: 409,
        body: {
          error: { code: 'slug_conflict', message: 'that name is taken here', details: {} },
        },
      },
      { status: 201, body: { entity: entity({ title: 'Reading again' }) } },
    ];
    const { sent, form } = sessionOver(queue);

    try {
      const refused = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      assert.equal(refused.kind, 'refused');
      assert.ok(refused.message !== '');

      await form.send({ containerType: 'area', parentAreaId: null, title: 'Reading again' });
      assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
    } finally {
      form.unmount();
    }
  });

  it('mints a new key when the form is opened again', async () => {
    const queue = [
      { status: 201, body: { entity: entity() } },
      { status: 201, body: { entity: entity({ id: 6 }) } },
    ];
    const { sent, form } = sessionOver(queue);

    try {
      await form.send({ containerType: 'area', parentAreaId: null, title: 'Reading' });
      form.reopen();
      await form.send({ containerType: 'area', parentAreaId: null, title: 'Writing' });

      // A new opening is a new question. Reusing the key would make the second creation a replay of
      // the first and hand back an area nobody asked for.
      assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
    } finally {
      form.unmount();
    }
  });

  it('reports the creation even when the cache refresh it triggers fails', async () => {
    const queue = [{ status: 201, body: { entity: entity() } }];
    const { sent, form } = sessionOver(queue);
    const invalidate = queryClient.invalidateQueries.bind(queryClient);

    queryClient.invalidateQueries = () => Promise.reject(new Error('the cache said no'));

    try {
      const outcome = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      // A refresh that could not be scheduled is not a creation that did not happen. Reporting it
      // as unconfirmed would send someone looking for something the server has already answered
      // for, and would leave the form inviting a second press under the same key.
      assert.equal(outcome.kind, 'created');
      assert.deepEqual(outcome.container, { type: 'area', id: 5 });
      assert.equal(sent.length, 1, 'and nothing is retried on its own');
    } finally {
      queryClient.invalidateQueries = invalidate;
      form.unmount();
    }
  });

  it('sends once for two presses in the same turn, and admits a later one', async () => {
    let answer;
    // The first request is held open, which is what makes "the same turn" reachable at all. Later
    // ones answer straight away.
    let hold = true;
    const sent = [];
    const reply = () =>
      new Response(JSON.stringify({ entity: entity() }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    const transport = createTransport({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(init.body));

        if (!hold) return reply();

        return new Promise((resolve) => {
          answer = () => {
            resolve(reply());
          };
        });
      },
    });

    activate(transport, 1);
    const form = mount();

    try {
      const both = form.sendTwice({ containerType: 'area', parentAreaId: null, title: 'Reading' });

      // The second press is decided in the same turn as the first, before any state has re-rendered.
      // A disabled button is a hint; this is the invariant.
      await until(() => sent.length > 0, 'the first request to leave');
      assert.equal(sent.length, 1);

      answer();

      let first;
      let second;

      await act(async () => {
        [first, second] = await both;
      });

      assert.equal(first.kind, 'created');
      // Nothing to say, and nothing to act on: no second navigation, selection or cache effect.
      assert.equal(second.kind, 'not_sent');
      assert.equal(second.message, '');
      assert.equal(sent.length, 1);

      // Admission is released once the first settles, and a later press is the same session's
      // replay - the same key, as the established policy says.
      hold = false;
      const later = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      assert.notEqual(later.kind, 'not_sent', 'admission was released');
      assert.equal(sent.length, 2);
      assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
    } finally {
      form.unmount();
    }
  });

  it('reports the creation without waiting for the refresh it triggers', async () => {
    const queue = [{ status: 201, body: { entity: entity() } }];
    const { form } = sessionOver(queue);
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    let asked = false;

    // A refresh that never finishes, which is what a retrying or hanging read looks like.
    queryClient.invalidateQueries = () => {
      asked = true;

      return new Promise(() => {});
    };

    try {
      const outcome = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      // The server answered; the tree reloading is a consequence of that, not part of it. Holding
      // the verdict behind it would leave the form saying "Saving…" about something already made.
      assert.equal(outcome.kind, 'created');
      assert.equal(asked, true, 'and the refresh was still asked for');
    } finally {
      queryClient.invalidateQueries = invalidate;
      form.unmount();
    }
  });

  it('sends nothing at all without a title', async () => {
    const { sent, form } = sessionOver([]);

    try {
      const outcome = await form.send({ containerType: 'area', parentAreaId: null, title: '   ' });

      assert.equal(outcome.kind, 'not_sent');
      assert.equal(sent.length, 0);
    } finally {
      form.unmount();
    }
  });

  it('files a project inside the area that was chosen, and an area at the root', async () => {
    const queue = [
      { status: 201, body: { entity: entity({ id: 7, type: 'project', parentId: 3 }) } },
      { status: 201, body: { entity: entity({ id: 8 }) } },
    ];
    const { sent, form } = sessionOver(queue);

    try {
      await form.send({ containerType: 'project', parentAreaId: 3, title: 'A project' });
      form.reopen();
      await form.send({ containerType: 'area', parentAreaId: null, title: 'An area' });

      assert.deepEqual(sent[0].parent, { id: 3 });
      // The root is spelled out rather than left to be inferred from an absent parent.
      assert.deepEqual(sent[1].parent, { path: '/' });
    } finally {
      form.unmount();
    }
  });
});

describe('a connection the form has outlived', () => {
  it('will not send under an activation the app has moved on from', async () => {
    const { sent, form } = sessionOver(['lost']);

    try {
      // The first press is what opens the session and captures the activation it was opened under.
      await form.send({ containerType: 'area', parentAreaId: null, title: 'Reading' });
      assert.equal(sent.length, 1);

      // A rotation, or a different server. The connection id survives a rotation by design, so the
      // activation is what catches it.
      activate(
        createTransport({ endpoint: ENDPOINT, apiKey: KEY, fetch: recordingFetch([], sent) }),
        2,
      );

      const outcome = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      assert.equal(outcome.kind, 'not_sent');
      assert.equal(sent.length, 1, 'nothing left this phone under the connection that is gone');
    } finally {
      form.unmount();
    }
  });

  it('does not hand back a container created against a server it has since left', async () => {
    const sent = [];
    const transport = createTransport({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(init.body));
        // The switch lands while the request is in the air.
        activate(transport, 9);

        return new Response(JSON.stringify({ entity: entity() }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    activate(transport, 1);
    const form = mount();

    try {
      const outcome = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      // It exists, on the other server. Nothing here may navigate to it or file a note in it: ids
      // are not portable, and a match would be a coincidence of numbers.
      assert.equal(outcome.kind, 'retired');
      assert.ok(outcome.message.includes('Check the other server'));
    } finally {
      form.unmount();
    }
  });
});

/** Every entity entry the cache holds, under any activation. */
const entityEntries = () =>
  queryClient.getQueryCache().findAll({ predicate: (query) => query.queryKey[2] === 'entity' });

describe('what a creation writes into the cache', () => {
  it('writes no entity, for an original or for a replay', async () => {
    // The replay answers with the creation as it was recorded - here, before the container was
    // renamed and archived. Seeding it would put that history on screen as current state.
    const queue = [
      { status: 201, body: { entity: entity() } },
      'lost',
      { status: 201, body: { entity: entity({ title: 'Reading (as it was created)' }) } },
    ];
    const { form } = sessionOver(queue);

    try {
      queryClient.clear();

      const original = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Reading',
      });

      assert.equal(original.kind, 'created');
      assert.deepEqual(entityEntries(), [], 'an original Create seeds nothing');

      form.reopen();
      await form.send({ containerType: 'area', parentAreaId: null, title: 'Writing' });
      const replay = await form.send({
        containerType: 'area',
        parentAreaId: null,
        title: 'Writing',
      });

      assert.equal(replay.kind, 'created');
      assert.deepEqual(entityEntries(), [], 'and neither does a replay');
    } finally {
      form.unmount();
    }
  });
});

describe('a parent archived while the form was open', () => {
  const archivedRefusal = {
    status: 409,
    body: {
      error: {
        code: 'node_archived',
        message: 'the parent is archived',
        details: { field: 'parent', reason: 'direct' },
      },
    },
  };

  it('is refused in words that fit a form whose parent is fixed', async () => {
    const { form } = sessionOver([archivedRefusal]);

    try {
      const outcome = await form.send({
        containerType: 'project',
        parentAreaId: 3,
        title: 'Tiles',
      });

      // "Pick another" would ask for something this form cannot do: its parent is where add was
      // pressed. The same sentence holds whichever way the area is archived.
      assert.equal(outcome.kind, 'refused');
      assert.equal(outcome.message, ARCHIVED_PARENT_CREATION_SENTENCE);
    } finally {
      form.unmount();
    }
  });

  it('marks every read under that connection stale, and no other', async () => {
    const { form } = sessionOver([archivedRefusal]);
    const here = scopeKey(1, 'entity', 'area', 3);
    const elsewhere = scopeKey(2, 'entity', 'area', 3);

    try {
      queryClient.clear();
      queryClient.setQueryData(here, { id: 3 });
      queryClient.setQueryData(elsewhere, { id: 3 });

      await form.send({ containerType: 'project', parentAreaId: 3, title: 'Tiles' });

      // The area screen behind the form learns it is archived from its own re-read. Archiving
      // changes more than the parent's Get, so the refresh is as broad as archive's own.
      assert.equal(queryClient.getQueryCache().find({ queryKey: here })?.state.isInvalidated, true);
      assert.equal(
        queryClient.getQueryCache().find({ queryKey: elsewhere })?.state.isInvalidated,
        false,
      );
    } finally {
      form.unmount();
    }
  });
});
