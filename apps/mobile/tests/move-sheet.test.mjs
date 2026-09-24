/**
 * Tapping a place to move something there.
 *
 * The real sheet over the app's own `QueryClient`, with the hierarchy seeded into the cache rather than
 * fetched. The move itself is the composition's `onMove`, substituted here, because what this sheet
 * owns is presentational: which places it offers, where the check starts, what a tap sends, what it
 * ignores, and what it says when a move does not happen. The owner's side of a move is proved in
 * `edit-move.test.mjs` and across the wire in `cross-client.test.mjs`.
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

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { createTransport } = await import('@raphael/client');
const { MoveSheet } = await import('../src/modules/capture/components/MoveSheet.tsx');
const {
  MOVE_CLOSE_WAITING_HINT,
  MOVE_ROOT_CURRENT_HINT,
  MOVE_ROOT_HINT,
  MOVE_TREE_FAILED,
  moveNotSentSentence,
} = await import('../src/modules/capture/edit-composer.ts');
const { useConnectionStore } = await import('../src/modules/connection/state/connection.ts');
const { queryClient } = await import('../src/infrastructure/query/query-client.ts');
const { scopeKey } = await import('../src/infrastructure/query/keys.ts');

after(() => {
  queryClient.clear();
});

const ACTIVATION = 1;

const node = (id, type, title, parentId, children = []) => ({
  id,
  type,
  parentId,
  slug: title.toLowerCase(),
  title,
  description: '',
  children,
});

/** Work { Raphael (project), Research { Papers (project) } }, Personal. */
const hierarchy = () => {
  const raphael = node(2, 'project', 'Raphael', 1);
  const papers = node(4, 'project', 'Papers', 3);
  const research = node(3, 'area', 'Research', 1, [papers]);
  const work = node(1, 'area', 'Work', null, [raphael, research]);
  const personal = node(5, 'area', 'Personal', null);

  return {
    roots: [work, personal],
    byId: new Map([
      [1, work],
      [2, raphael],
      [3, research],
      [4, papers],
      [5, personal],
    ]),
  };
};

/** The session every case reads under. A case about a failed read swaps in a transport that fails. */
const activate = (transport) => {
  useConnectionStore.setState({
    phase: {
      kind: 'active',
      rejection: null,
      session: {
        activation: ACTIVATION,
        transport,
        connection: {
          connectionId: 'c1',
          base: 'https://raphael.example',
          origin: 'https://raphael.example',
          protocolVersion: 1,
        },
      },
    },
  });
};

activate({});

const NOTE = { id: 42, type: 'resource', kind: 'note', slug: 'sync-notes' };

/** A promise the test answers when it chooses, so "while the answer is out" is a real interval. */
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

const open = (options = {}) => {
  if (options.tree === null) {
    // Nothing read yet: the sheet's own observer asks, and the case's transport answers.
    queryClient.removeQueries({ queryKey: scopeKey(ACTIVATION, 'hierarchy') });
  } else {
    queryClient.setQueryData(scopeKey(ACTIVATION, 'hierarchy'), options.tree ?? hierarchy());
  }

  const asked = [];
  const closed = [];
  const answers = options.answers ?? [];
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MoveSheet, {
          visible: true,
          sessionId: 1,
          entity: options.entity ?? NOTE,
          parentId: options.parentId === undefined ? 2 : options.parentId,
          currentName: options.currentName ?? 'Raphael',
          onMove: (destination) => {
            asked.push(destination);

            return answers.shift() ?? Promise.resolve({ kind: 'moved', parentId: null });
          },
          onClose: () => closed.push(true),
        }),
      ),
    );
  });

  const find = (label) => host.querySelector(`[aria-label="${label}"]`);
  const byTestId = (id) => host.querySelector(`[data-testid="${id}"]`);

  return {
    asked,
    closed,
    text: () => host.textContent ?? '',
    find,
    byTestId,
    labels: () =>
      [...host.querySelectorAll('[aria-selected]')].map((row) => row.getAttribute('aria-label')),
    checked: () =>
      [...host.querySelectorAll('[aria-selected="true"]')].map((row) =>
        row.getAttribute('aria-label'),
      ),
    tap: (label) => {
      const control = find(label);

      assert.ok(control !== null, `no control called ${label}`);
      act(() => {
        control.click();
      });
    },
    /** Let an answered move's consequences land. */
    settle: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('the move sheet', () => {
  it('opens with the check on where this is now, its ancestors open, and no top level for a note', () => {
    const sheet = open();

    try {
      assert.deepEqual(sheet.checked(), ['Raphael']);
      assert.deepEqual(sheet.labels(), ['Work', 'Raphael', 'Research', 'Personal']);
      assert.equal(sheet.byTestId('move-root'), null);
      assert.ok(sheet.text().includes('Where should this go?'));
      assert.ok(sheet.text().includes('In Raphael now. Tap a place to move this there.'));
      assert.equal(
        sheet.find('Personal').getAttribute('aria-description'),
        'Moves this note into Personal',
      );
      // Nothing to type: no ID field and no confirm.
      assert.equal(sheet.byTestId('move-slug'), null);
      assert.equal(sheet.byTestId('move-confirm'), null);
    } finally {
      sheet.unmount();
    }
  });

  it('moves on a tap, sending the parent and never a slug', async () => {
    const sheet = open();

    try {
      sheet.tap('Personal');
      await sheet.settle();

      assert.deepEqual(sheet.asked, [{ parentId: 5 }]);
      assert.equal(sheet.byTestId('move-problem'), null);
    } finally {
      sheet.unmount();
    }
  });

  it('closes without moving when the current place is tapped', () => {
    const sheet = open();

    try {
      sheet.tap('Raphael');

      assert.deepEqual(sheet.asked, []);
      assert.equal(sheet.closed.length, 1);
    } finally {
      sheet.unmount();
    }
  });

  it('ignores taps and holds every way out while the answer is out, and says so', async () => {
    const answer = deferred();
    const sheet = open({ answers: [answer.promise] });

    try {
      sheet.tap('Personal');

      assert.ok(sheet.text().includes('Moving to Personal…'));
      assert.deepEqual(sheet.checked(), ['Personal']);

      sheet.tap('Work');
      sheet.tap('Raphael');
      assert.deepEqual(sheet.asked, [{ parentId: 5 }], 'one move, however many taps');
      assert.equal(sheet.closed.length, 0, 'the current place does not close it either');

      const close = sheet.byTestId('move-close');

      assert.equal(close.getAttribute('aria-disabled'), 'true');
      assert.equal(close.getAttribute('aria-description'), MOVE_CLOSE_WAITING_HINT);
      act(() => {
        close.click();
      });
      assert.equal(sheet.closed.length, 0);

      answer.resolve({ kind: 'moved', parentId: 5 });
      await sheet.settle();

      assert.notEqual(sheet.byTestId('move-close').getAttribute('aria-disabled'), 'true');
    } finally {
      sheet.unmount();
    }
  });

  it('puts the check back and says why when the server refuses', async () => {
    const sheet = open({
      answers: [
        Promise.resolve({
          kind: 'refused',
          failure: {
            kind: 'api_error',
            status: 409,
            mutationOutcome: 'not_applied',
            message: 'conflict',
            error: { code: 'slug_conflict', message: 'conflict' },
            details: { field: 'destination' },
          },
        }),
      ],
    });

    try {
      sheet.tap('Personal');
      await sheet.settle();

      const problem = sheet.byTestId('move-problem');

      assert.equal(
        problem.textContent,
        'Something in Personal already uses the note ID “sync-notes”. Change this note ID in Details, then move it.',
      );
      assert.equal(problem.getAttribute('aria-live'), 'assertive');
      assert.deepEqual(sheet.checked(), ['Raphael']);
      assert.equal(sheet.closed.length, 0, 'the sheet stays open');
      assert.ok(sheet.text().includes('In Raphael now.'));
    } finally {
      sheet.unmount();
    }
  });

  it('says why a move was not sent, and stays open', async () => {
    const sheet = open({
      answers: [Promise.resolve({ kind: 'not_sent', reason: 'unsent_writing' })],
    });

    try {
      sheet.tap('Work');
      await sheet.settle();

      assert.equal(
        sheet.byTestId('move-problem').textContent,
        moveNotSentSentence('unsent_writing'),
      );
      assert.deepEqual(sheet.checked(), ['Raphael']);
      assert.equal(sheet.closed.length, 0);

      // The next tap is a fresh attempt, and the old sentence does not stand over it.
      sheet.tap('Personal');
      assert.equal(sheet.byTestId('move-problem'), null);
    } finally {
      sheet.unmount();
    }
  });

  it('offers a project areas only', () => {
    const sheet = open({
      entity: { id: 2, type: 'project', kind: null, slug: 'raphael' },
      parentId: 1,
      currentName: 'Work',
    });

    try {
      assert.deepEqual(sheet.labels(), ['Work', 'Research', 'Personal']);
      assert.equal(sheet.byTestId('move-root'), null);
      assert.equal(
        sheet.find('Personal').getAttribute('aria-description'),
        'Moves this project into Personal',
      );
    } finally {
      sheet.unmount();
    }
  });

  describe('for an area', () => {
    const RESEARCH = { id: 3, type: 'area', kind: null, slug: 'research' };

    it('offers the top level as "Areas", and every area but itself and what is beneath it', () => {
      const sheet = open({ entity: RESEARCH, parentId: 1, currentName: 'Work' });

      try {
        assert.deepEqual(sheet.labels(), ['Areas, Top level', 'Work', 'Personal']);

        const root = sheet.byTestId('move-root');

        assert.equal(root.getAttribute('aria-description'), MOVE_ROOT_HINT);
        assert.equal(root.getAttribute('aria-selected'), 'false');
        assert.deepEqual(sheet.checked(), ['Work']);
      } finally {
        sheet.unmount();
      }
    });

    it('moves to the top level from the root row', async () => {
      const answer = deferred();
      const sheet = open({
        entity: RESEARCH,
        parentId: 1,
        currentName: 'Work',
        answers: [answer.promise],
      });

      try {
        sheet.tap('Areas, Top level');

        assert.deepEqual(sheet.asked, [{ parentId: null }]);
        assert.ok(sheet.text().includes('Moving to the top level…'));
        assert.equal(sheet.byTestId('move-root').getAttribute('aria-selected'), 'true');

        answer.resolve({ kind: 'moved', parentId: null });
        await sheet.settle();
      } finally {
        sheet.unmount();
      }
    });

    it('checks the root row for an area already at the top level, and closes on it', () => {
      const WORK = { id: 1, type: 'area', kind: null, slug: 'work' };
      const sheet = open({ entity: WORK, parentId: null, currentName: 'Areas' });

      try {
        assert.ok(sheet.text().includes('In Areas now.'));
        assert.equal(sheet.byTestId('move-root').getAttribute('aria-selected'), 'true');
        assert.equal(
          sheet.byTestId('move-root').getAttribute('aria-description'),
          MOVE_ROOT_CURRENT_HINT,
        );

        sheet.tap('Areas, Top level');
        assert.deepEqual(sheet.asked, []);
        assert.equal(sheet.closed.length, 1);
      } finally {
        sheet.unmount();
      }
    });

    it('shows only the top level when nothing else can hold it, with no empty sentence', () => {
      const only = node(1, 'area', 'Work', null);
      const sheet = open({
        entity: { id: 1, type: 'area', kind: null, slug: 'work' },
        parentId: null,
        currentName: 'Areas',
        tree: { roots: [only], byId: new Map([[1, only]]) },
      });

      try {
        assert.deepEqual(sheet.labels(), ['Areas, Top level']);
        assert.ok(!sheet.text().includes('can hold this'));
      } finally {
        sheet.unmount();
      }
    });
  });
});

describe('the move sheet over a tree that did not load', () => {
  /** A transport whose every list fails as an unreachable server does, counting the attempts. */
  const unreachable = () => {
    const attempts = { count: 0 };
    const transport = createTransport({
      endpoint: 'https://raphael.example',
      apiKey: `test-${'k'.repeat(40)}`,
      fetch: async () => {
        attempts.count += 1;
        throw new TypeError('Network request failed');
      },
    });

    return { attempts, transport };
  };

  const failing = async (options) => {
    const { attempts, transport } = unreachable();

    activate(transport);
    // One attempt per read, so "it failed" and "it was asked again" are countable.
    queryClient.setQueryDefaults(scopeKey(ACTIVATION, 'hierarchy'), { retry: false });

    const sheet = open({ ...options, tree: null });

    await sheet.settle();
    await sheet.settle();

    return { attempts, sheet };
  };

  after(() => {
    queryClient.setQueryDefaults(scopeKey(ACTIVATION, 'hierarchy'), {});
    activate({});
  });

  it('says so and offers to ask again, which asks again', async () => {
    const { attempts, sheet } = await failing();

    try {
      assert.ok(sheet.text().includes(MOVE_TREE_FAILED));

      const before = attempts.count;

      assert.ok(before >= 1, 'the tree was asked for');
      sheet.tap('Try again');
      await sheet.settle();
      assert.ok(attempts.count > before, 'Try again reads the tree again');
      // A note has no place to go without the tree, so nothing else is offered.
      assert.equal(sheet.byTestId('move-root'), null);
    } finally {
      sheet.unmount();
    }
  });

  it('keeps the top level for an area, which needs no tree to choose', async () => {
    const { sheet } = await failing({
      entity: { id: 3, type: 'area', kind: null, slug: 'research' },
      parentId: 1,
      currentName: 'Work',
    });

    try {
      assert.ok(sheet.text().includes(MOVE_TREE_FAILED));
      sheet.tap('Areas, Top level');
      assert.deepEqual(sheet.asked, [{ parentId: null }]);
      await sheet.settle();
    } finally {
      sheet.unmount();
    }
  });
});

describe('the move sheet over a tree whose refresh failed', () => {
  after(() => {
    queryClient.setQueryDefaults(scopeKey(ACTIVATION, 'hierarchy'), {});
    activate({});
  });

  it('keeps the tree it read, says it may be out of date, and offers to ask again', async () => {
    const attempts = { count: 0 };

    activate(
      createTransport({
        endpoint: 'https://raphael.example',
        apiKey: `test-${'k'.repeat(40)}`,
        fetch: async () => {
          attempts.count += 1;
          throw new TypeError('Network request failed');
        },
      }),
    );
    queryClient.setQueryDefaults(scopeKey(ACTIVATION, 'hierarchy'), { retry: false });

    // A complete tree from an earlier reading is on screen before anything fails.
    const sheet = open();

    try {
      assert.equal(sheet.find('Try again'), null, 'nothing to recover from yet');

      await act(async () => {
        await queryClient
          .refetchQueries({ queryKey: scopeKey(ACTIVATION, 'hierarchy') })
          .catch(() => undefined);
      });
      await sheet.settle();

      // The places are still offered, and the sheet says they may not be current.
      for (const place of ['Work', 'Raphael', 'Research', 'Personal']) {
        assert.ok(sheet.find(place) !== null, `${place} is still offered`);
      }
      assert.ok(sheet.find('Try again') !== null, 'a retry is offered');

      const before = attempts.count;

      sheet.tap('Try again');
      await sheet.settle();
      assert.ok(attempts.count > before, 'Try again reads the tree again');
    } finally {
      sheet.unmount();
    }
  });
});
