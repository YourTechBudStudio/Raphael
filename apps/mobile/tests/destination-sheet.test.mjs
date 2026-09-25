/**
 * Choosing where a note goes, and making somewhere to put it without leaving.
 *
 * The real sheet, over the app's own `QueryClient`, a configured connection and a substituted
 * transport. The rules it owns are presentational - which chip is offered, what a refusal leaves
 * behind, whether success closes - so a helper extracted to avoid mounting it would test something
 * else. The hierarchy is seeded into the cache rather than fetched, because what is under test is
 * the sheet, not the traversal `collections` already has its own tests for.
 *
 * What is real: the sheet, the selectable tree, the creation session, the client and the cache. What
 * is substituted is `fetch`, so the request that goes out is the one the app would send and the key
 * is read back off the wire.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.teardown());

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createTransport } = await import('@raphael/client');
const { DestinationSheet } = await import('../src/modules/capture/components/DestinationSheet.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');

after(() => {
  queryClient.clear();
});

const KEY = `test-${'k'.repeat(40)}`;
const ENDPOINT = 'https://raphael.example';
const ACTIVATION = 1;

const node = (id, type, title, children = []) => ({
  id,
  type,
  parentId: null,
  slug: title.toLowerCase(),
  title,
  description: '',
  children,
});

/** Work (an area) holding Notes (a project). Enough to exercise both chips. */
const hierarchy = () => {
  const notes = { ...node(2, 'project', 'Notes'), parentId: 1 };
  const work = node(1, 'area', 'Work', [notes]);

  return {
    roots: [work],
    byId: new Map([
      [1, work],
      [2, notes],
    ]),
  };
};

const entity = (over = {}) => ({
  id: 9,
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

const open = (options = {}) => {
  const sent = [];
  const answers = options.answers ?? [];
  const transport = createTransport({
    endpoint: ENDPOINT,
    apiKey: KEY,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);

      /**
       * A successful creation invalidates the hierarchy, and the sheet is *observing* it, so the
       * tree really refetches. That read is answered with an empty page rather than queued, because
       * it is a consequence of the creation rather than a thing this test is about - and letting it
       * take the next queued answer would make every assertion depend on how many reads the cache
       * happened to schedule.
       */
      if (String(url).endsWith('/list')) {
        return new Response(JSON.stringify({ items: [], skip: 0, limit: 500, hasMore: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      sent.push(body);

      const next = answers.shift();

      if (next === undefined || next === 'lost') throw new TypeError('Network request failed');

      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  activate(transport, ACTIVATION);
  // Seeded rather than fetched: the query is enabled, finds data, and never asks the transport.
  queryClient.setQueryData(scopeKey(ACTIVATION, 'hierarchy'), hierarchy());

  const selected = [];
  const closed = [];
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DestinationSheet, {
          visible: true,
          sessionId: 1,
          selected: options.selected ?? null,
          onSelect: (destination) => selected.push(destination),
          onClose: () => closed.push(true),
        }),
      ),
    );
  });

  const find = (label) => host.querySelector(`[aria-label="${label}"]`);

  return {
    host,
    sent,
    selected,
    closed,
    text: () => host.textContent ?? '',
    find,
    press: (label) => {
      const control = find(label);

      assert.ok(control !== null, `no control called ${label}`);
      act(() => {
        control.click();
      });
    },
    type: (label, text) => {
      const field = find(label);

      assert.ok(field !== null, `no field called ${label}`);

      const prototype =
        field.tagName === 'TEXTAREA'
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;

      act(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
        field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    },
    /**
     * Let the request finish and its consequences land.
     *
     * Several turns rather than one: a success runs the whole chain - decode, seed, invalidate, then
     * the sheet's own state - and counting awaits in the implementation would make this fail when a
     * line moves rather than when behaviour changes.
     */
    settle: async () => {
      await act(async () => {
        for (let turn = 0; turn < 20; turn += 1) {
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
        }
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

beforeEach(() => {
  queryClient.clear();
});

describe('what the sheet offers to create', () => {
  it('offers an area at the root, and refuses to pretend a project can live there', async () => {
    const sheet = open();

    try {
      assert.ok(sheet.find('New area') !== null);
      // The root holds only areas, so the chip is there and unavailable rather than absent: what is
      // missing is the area to put it in, and a control that vanishes does not say that.
      assert.equal(sheet.find('New project').disabled, true);

      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      assert.ok(sheet.find('Create') !== null);
    } finally {
      sheet.unmount();
    }
  });

  it('offers a project once an area is chosen, and files it in that area', async () => {
    const sheet = open({
      selected: { type: 'area', id: 1 },
      answers: [{ status: 201, body: { entity: entity({ id: 5, type: 'project', parentId: 1 }) } }],
    });

    try {
      assert.equal(sheet.find('New project').disabled, false);

      sheet.press('New project');
      sheet.type('Project title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      assert.deepEqual(sheet.sent[0].parent, { id: 1 }, 'inside the area that was chosen');
      assert.equal(sheet.sent[0].type, 'project');
    } finally {
      sheet.unmount();
    }
  });

  it('puts a new area at the root when what is selected is a project', async () => {
    const sheet = open({
      selected: { type: 'project', id: 2 },
      answers: [{ status: 201, body: { entity: entity({ id: 4 }) } }],
    });

    try {
      // Only a selected *area* is a place to create inside. Reaching for the project's parent would
      // file the new area beside it, in an area nobody picked.
      assert.equal(
        sheet.find('New project').disabled,
        true,
        'and a project cannot hold one either',
      );
      // The hint describes where it actually goes, rather than "inside the chosen one".
      assert.equal(
        sheet.find('New area').getAttribute('aria-description'),
        'Creates an area at the top level',
      );

      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      assert.deepEqual(sheet.sent[0].parent, { path: '/' });
    } finally {
      sheet.unmount();
    }
  });

  it('creates an area inside the chosen one, not beside it', async () => {
    const sheet = open({
      selected: { type: 'area', id: 1 },
      answers: [{ status: 201, body: { entity: entity({ id: 6, parentId: 1 }) } }],
    });

    try {
      assert.equal(
        sheet.find('New area').getAttribute('aria-description'),
        'Creates an area inside Work',
      );

      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      assert.deepEqual(sheet.sent[0].parent, { id: 1 });
    } finally {
      sheet.unmount();
    }
  });
});

describe('what an answer does to the sheet', () => {
  it('selects exactly what was created, once', async () => {
    const sheet = open({
      answers: [{ status: 201, body: { entity: entity({ id: 9 }) } }],
    });

    try {
      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      // The reference the server returned, not the one the form was aiming at. Read field by
      // field: the decoder hands back an object whose prototype a deep comparison would trip on.
      assert.equal(sheet.selected.length, 1, 'and the caller is told once');
      assert.equal(sheet.selected[0].type, 'area');
      assert.equal(sheet.selected[0].id, 9);
    } finally {
      sheet.unmount();
    }
  });

  it('keeps the title and the chosen parent when the server refuses', async () => {
    const sheet = open({
      selected: { type: 'area', id: 1 },
      answers: [
        {
          status: 409,
          body: {
            error: { code: 'slug_conflict', message: 'that name is taken here', details: {} },
          },
        },
        { status: 201, body: { entity: entity({ id: 7, parentId: 1 }) } },
      ],
    });

    try {
      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      assert.ok(sheet.text().includes('that name is taken here'));
      assert.equal(sheet.find('Area title').value, 'Reading', 'the title is kept for another go');
      assert.deepEqual(sheet.selected, [], 'and nothing was selected');

      // The parent is still the one that was chosen, and the key is still the session's.
      sheet.press('Create');
      await sheet.settle();

      assert.deepEqual(sheet.sent[1].parent, { id: 1 });
      assert.equal(sheet.sent[0].idempotencyKey, sheet.sent[1].idempotencyKey);
    } finally {
      sheet.unmount();
    }
  });

  it('reports a lost answer without selecting, closing, or trying again', async () => {
    const sheet = open({ selected: { type: 'area', id: 1 }, answers: ['lost'] });

    try {
      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      assert.ok(sheet.text().includes('Look for it before creating it again'));
      assert.equal(sheet.sent.length, 1, 'nothing is retried on its own');
      assert.deepEqual(sheet.selected, []);
      assert.deepEqual(sheet.closed, []);
      // The earlier selection and everything written are exactly where they were.
      assert.equal(sheet.find('Area title').value, 'Reading');
    } finally {
      sheet.unmount();
    }
  });

  it('will not select a container made against a server the app has since left', async () => {
    const sheet = open({
      selected: { type: 'area', id: 1 },
      answers: [{ status: 201, body: { entity: entity({ id: 8 }) } }],
    });

    try {
      sheet.press('New area');
      sheet.type('Area title', 'Reading');

      // The switch lands while the request is in the air.
      act(() => {
        sheet.press('Create');
      });
      activate(useConnectionStore.getState().phase.session.transport, ACTIVATION + 1);
      await sheet.settle();

      // It exists, on the other server. Ids are not portable, so a match here would be a
      // coincidence of numbers - and a note filed into it would be filed nowhere a person chose.
      assert.deepEqual(sheet.selected, []);
      assert.deepEqual(sheet.closed, []);
      assert.ok(sheet.text().includes('Check the other server'));
    } finally {
      sheet.unmount();
    }
  });
});

describe('dismissing the sheet', () => {
  it('closes the session, so the next opening is a new question', async () => {
    const sheet = open({
      answers: [
        { status: 201, body: { entity: entity({ id: 11 }) } },
        { status: 201, body: { entity: entity({ id: 12 }) } },
      ],
    });

    try {
      sheet.press('New area');
      sheet.type('Area title', 'Reading');
      sheet.press('Create');
      await sheet.settle();

      sheet.press('Close');
      assert.deepEqual(sheet.closed, [true], 'the host is told, and owns the open state');
    } finally {
      sheet.unmount();
    }
  });

  it('picking a place is choosing it, not going there', async () => {
    const sheet = open();

    try {
      sheet.press('Work');

      assert.equal(sheet.selected.length, 1);
      assert.equal(sheet.selected[0].type, 'area');
      assert.equal(sheet.selected[0].id, 1);
      assert.equal(sheet.sent.length, 0, 'nothing is created by choosing somewhere that exists');
    } finally {
      sheet.unmount();
    }
  });
});
