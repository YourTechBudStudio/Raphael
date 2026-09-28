/**
 * Creating an area or a project through `unsent`, the same way a note is created.
 *
 * The real sheet over the real `unsent` table (Node SQLite) and runner, with only `fetch` substituted,
 * so the request that goes out is the one the app would send. What is pinned: an empty sheet leaves
 * nothing behind, a closed sheet keeps what was written as a draft, a kept draft reopens filled in,
 * Save sends a client-chosen title and slug, and a refusal says the server's reason.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';
import { nodeDriver } from './support/node-sqlite.mjs';

const hooks = installNativeStubs();
after(() => hooks.deregister());

const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.teardown());

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createTransport } = await import('@raphael/client');
const { NewContainerSheet } =
  await import('../src/modules/collections/components/NewContainerSheet.tsx');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { discardAllUnsent, resumeUnsent, startUnsent, stopUnsent, useUnsentState } =
  await import('../src/modules/unsent/client/unsent.ts');

await startUnsent(nodeDriver());

after(() => {
  stopUnsent();
  queryClient.clear();
});

const ENDPOINT = 'https://raphael.example';

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
  isFavorite: false,
  archiveCauses: [],
  body: { format: 'tiptap', value: { type: 'doc', content: [{ type: 'paragraph' }] } },
  metadata: {},
  ...over,
});

const open = ({
  answers = [],
  draftId = null,
  containerType = 'area',
  parentAreaId = null,
} = {}) => {
  const sent = [];
  const transport = createTransport({
    endpoint: ENDPOINT,
    apiKey: `test-${'k'.repeat(40)}`,
    fetch: async (url, init) => {
      if (String(url).endsWith('/list')) {
        return new Response(JSON.stringify({ items: [], skip: 0, limit: 500, hasMore: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      sent.push(JSON.parse(init.body));

      const next = answers.shift();

      if (next === undefined) throw new TypeError('Network request failed');

      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: 1,
        transport,
        connection: { connectionId: 'c1', base: ENDPOINT, origin: ENDPOINT, protocolVersion: 1 },
      },
    },
  });

  const created = [];
  const closed = [];
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(NewContainerSheet, {
          visible: true,
          draftId,
          containerType,
          parentAreaId,
          onClose: () => closed.push(true),
          onCreated: (container) => created.push(container),
        }),
      ),
    );
  });

  const find = (label) => host.querySelector(`[aria-label="${label}"]`);
  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    });
  };

  return {
    sent,
    created,
    closed,
    settle,
    find,
    text: () => host.textContent ?? '',
    press: async (label) => {
      act(() => {
        find(label).click();
      });
      await settle();
    },
    type: async (label, text) => {
      const field = find(label);
      const prototype =
        field.tagName === 'TEXTAREA'
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;

      act(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
        field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      await settle();
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
};

const rows = () => useUnsentState.getState().rows;

beforeEach(async () => {
  queryClient.clear();
  await discardAllUnsent();
  // The wipe seals writes for a server switch; a test's reset is not one.
  resumeUnsent();
});

describe('the area and project sheet', () => {
  it('leaves nothing behind when it is opened and closed empty', async () => {
    const sheet = open();

    try {
      await sheet.press('Close');

      assert.deepEqual(sheet.closed, [true]);
      assert.equal(rows().length, 0);
    } finally {
      sheet.unmount();
    }
  });

  it('keeps what was written as a draft when it is closed, and reopens it filled in', async () => {
    const first = open();

    try {
      await first.type('Area title', 'Reading');
      await first.type('Notes', 'Books and papers');
      await first.press('Close');

      assert.equal(rows().length, 1);
      assert.equal(rows()[0].status, 'draft');
      assert.equal(rows()[0].description, 'Books and papers');
    } finally {
      first.unmount();
    }

    const again = open({ draftId: rows()[0].id });

    try {
      assert.equal(again.find('Area title').value, 'Reading');
      assert.equal(again.find('Notes').value, 'Books and papers');
    } finally {
      again.unmount();
    }
  });

  it('saves with a title and slug it chose, and hands back what the server created', async () => {
    const sheet = open({
      containerType: 'project',
      parentAreaId: 1,
      answers: [{ status: 201, body: { entity: entity({ id: 5, type: 'project', parentId: 1 }) } }],
    });

    try {
      await sheet.type('Project title', '  Reading List ');
      await sheet.press('Save');

      assert.equal(sheet.sent.length, 1);
      assert.equal(sheet.sent[0].type, 'project');
      assert.equal(sheet.sent[0].title, 'Reading List');
      assert.equal(sheet.sent[0].slug, 'reading-list');
      assert.deepEqual(sheet.sent[0].parent, { id: 1 });
      assert.deepEqual(sheet.created, [{ type: 'project', id: 5 }]);
      assert.equal(rows().length, 0, 'the row is gone once the server has it');
    } finally {
      sheet.unmount();
    }
  });

  it('says the server’s reason under the fields when it refuses', async () => {
    const sheet = open({
      parentAreaId: 1,
      answers: [
        {
          status: 409,
          body: {
            error: { code: 'node_archived', message: 'The parent is inside something archived.' },
          },
        },
      ],
    });

    try {
      await sheet.type('Area title', 'Reading');
      await sheet.press('Save');

      assert.ok(sheet.text().includes('Not saved: The parent is inside something archived.'));
      assert.deepEqual(sheet.created, []);
      assert.equal(rows()[0].status, 'refused');
    } finally {
      sheet.unmount();
    }
  });
});
