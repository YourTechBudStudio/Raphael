/**
 * The components a person actually sees, rendered.
 *
 * `feed-state.test.mjs` settles what the six states *are*; this settles that the sections built on
 * them show the right thing for each, which is a different claim and the one that would silently
 * break. A screen can derive a perfectly correct state and then render a line for the wrong one.
 *
 * The full Home, Area and Project screens are deliberately not mounted. They are compositions of
 * these sections plus navigation, a connection store and a router, and standing all of that up would
 * test the substitutes more than the product. What the screens own beyond these components - which
 * copy they pass, what a pull-down refreshes - is one line each and is covered where it lives.
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
const { setScreenReaderEnabled, setWindowDimensions } =
  await import('./support/stubs/react-native.mjs');
const { deriveNoteFeed } = await import('../src/modules/resources/client/feed-state.ts');
const { NoteSection } = await import('../src/modules/resources/components/NoteSection.tsx');
const { NoteCard } = await import('../src/modules/resources/components/NoteCard.tsx');
const { NoteGrid } = await import('../src/modules/resources/components/NoteGrid.tsx');
const { HOME_NOTES_COPY, CONTAINER_NOTES_COPY } =
  await import('../src/modules/resources/components/notes-copy.ts');

const note = (id, over = {}) => ({
  id,
  title: `Note ${String(id)}`,
  description: '',
  slug: `note-${String(id)}`,
  revision: 1,
  parentId: 3,
  ...over,
});

const page = (ids, over = {}) => ({
  items: ids.map((id) => note(id)),
  skip: 0,
  limit: 50,
  hasMore: false,
  ...over,
});

const observation = (over = {}) => ({
  pages: undefined,
  isPending: false,
  isError: false,
  isFetchNextPageError: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  ...over,
});

/** Mounts an element and returns the container plus a teardown. */
const render = (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return {
    container,
    text: () => container.textContent,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const section = (view, copy = CONTAINER_NOTES_COPY, extra = {}) =>
  render(createElement(NoteSection, { view, copy, ...extra }));

/** The cards in a container, in document order, each named by its own key. */
const cardOrder = (container) =>
  [...container.querySelectorAll('[data-testid^="note-card-"]')].map((element) =>
    element.getAttribute('data-testid'),
  );

/** `assert.equal` on a DOM node serializes the whole tree on failure; ask about presence instead. */
const has = (container, selector) => container.querySelector(selector) !== null;

describe('the Notes section, state by state', () => {
  it('shows the loading shape and says nothing while the first page is on its way', () => {
    const view = render(
      createElement(NoteSection, {
        view: deriveNoteFeed(observation({ isPending: true })),
        copy: CONTAINER_NOTES_COPY,
      }),
    );

    assert.equal(has(view.container, '[aria-label="Loading notes"]'), true);
    assert.ok(!view.text().includes(CONTAINER_NOTES_COPY.empty), 'loading must not read as empty');
    assert.ok(!view.text().includes(CONTAINER_NOTES_COPY.failed));
    view.unmount();
  });

  it('says there is nothing here only when the read succeeded', () => {
    const view = section(deriveNoteFeed(observation({ pages: [page([])] })));

    assert.ok(view.text().includes('No notes found.'));
    assert.ok(!view.text().includes('Unable to load notes.'));
    view.unmount();
  });

  it('says it could not read them, with no cards, when the first read failed', () => {
    const view = section(deriveNoteFeed(observation({ isPending: true, isError: true })));

    assert.ok(view.text().includes('Unable to load notes.'));
    assert.ok(!view.text().includes('No notes found.'), 'a failure must never read as emptiness');
    assert.equal(view.container.querySelectorAll('[data-testid^="note-card-"]').length, 0);
    view.unmount();
  });

  it('keeps the cards and reports the failure when a refresh failed', () => {
    const view = section(deriveNoteFeed(observation({ pages: [page([1, 2])], isError: true })));

    assert.equal(view.container.querySelectorAll('[data-testid^="note-card-"]').length, 2);
    assert.ok(view.text().includes('Unable to load notes.'));
    view.unmount();
  });

  it('keeps every card and reports only the page when a next page failed', () => {
    const view = section(
      deriveNoteFeed(
        observation({
          pages: [page([1, 2], { hasMore: true })],
          isError: true,
          isFetchNextPageError: true,
          hasNextPage: true,
        }),
      ),
    );

    assert.equal(view.container.querySelectorAll('[data-testid^="note-card-"]').length, 2);
    assert.ok(view.text().includes('More notes did not load.'));
    assert.ok(
      !view.text().includes('Unable to load notes.'),
      'one refused page is not the feed failing',
    );
    view.unmount();
  });

  it('keeps every card and says another page is coming while it loads', () => {
    const view = section(
      deriveNoteFeed(
        observation({
          pages: [page([1], { hasMore: true })],
          isFetchingNextPage: true,
          hasNextPage: true,
        }),
      ),
    );

    assert.equal(view.container.querySelectorAll('[data-testid^="note-card-"]').length, 1);
    assert.ok(view.text().includes('Loading more'));
    view.unmount();
  });

  it('claims nothing about completeness while there is more to read', () => {
    const view = section(
      deriveNoteFeed(observation({ pages: [page([1], { hasMore: true })], hasNextPage: true })),
    );

    assert.ok(!view.text().includes('No notes found.'));
    view.unmount();
  });
});

describe('Home and a container say different things', () => {
  it('Home invites, now that the control it names is on the screen', () => {
    const view = section(deriveNoteFeed(observation({ pages: [page([])] })), HOME_NOTES_COPY);

    // Phase 05 held the second half of the frozen sentence back because New note was absent, and
    // pointing someone at a control that was not there would have been a lie. Phase 06 restored the
    // control, so the sentence comes back with it.
    assert.ok(view.text().includes('No notes yet.'));
    assert.ok(view.text().includes('New note'));
    view.unmount();
  });

  it('Home points at the pull-down it has; a container page says only what failed', () => {
    const home = section(
      deriveNoteFeed(observation({ isPending: true, isError: true })),
      HOME_NOTES_COPY,
    );
    assert.ok(home.text().includes('Unable to load notes. Pull down to try again.'));
    home.unmount();

    const container = section(deriveNoteFeed(observation({ isPending: true, isError: true })));
    assert.ok(container.text().includes('Unable to load notes.'));
    assert.ok(!container.text().includes('Pull down'));
    container.unmount();
  });
});

describe('the heading accessory', () => {
  it('is drawn on the heading’s row when a screen has one, and nowhere otherwise', () => {
    const view = section(deriveNoteFeed(observation({ pages: [page([])] })), HOME_NOTES_COPY, {
      headingTrailing: createElement(
        'span',
        { 'data-testid': 'heading-accessory' },
        '3 unfinished',
      ),
    });

    assert.ok(has(view.container, '[data-testid="heading-accessory"]'));
    assert.ok(view.text().includes('Notes'));
    view.unmount();

    const bare = section(deriveNoteFeed(observation({ pages: [page([])] })), HOME_NOTES_COPY);

    assert.ok(!has(bare.container, '[data-testid="heading-accessory"]'));
    bare.unmount();
  });

  /**
   * The grid draws the server's notes and nothing else.
   *
   * It used to take leading cards for the unfinished notes Home drew before the feed. Home draws no
   * unfinished cards of any kind now, so the mechanism was removed rather than left with no caller,
   * and this says so where the tests for it used to be.
   */
  it('is the only thing a screen may add; the grid itself takes no cards but the server’s', () => {
    const view = render(createElement(NoteGrid, { items: [note(1), note(2)] }));

    assert.deepEqual(cardOrder(view.container), ['note-card-1', 'note-card-2']);
    view.unmount();
  });
});

describe('a note card', () => {
  it('names where it is filed when the hierarchy could answer', () => {
    const view = render(createElement(NoteCard, { note: note(1), location: 'Kitchen' }));

    assert.ok(view.text().includes('Kitchen'));
    // The location replaces the kind label rather than joining it.
    assert.equal(has(view.container, '[data-icon="Layers"]'), true);
    assert.equal(has(view.container, '[data-icon="FileText"]'), false);
    view.unmount();
  });

  it('falls back to the kind when it could not', () => {
    const view = render(createElement(NoteCard, { note: note(1) }));

    assert.ok(view.text().includes('Note'));
    assert.equal(has(view.container, '[data-icon="FileText"]'), true);
    assert.equal(has(view.container, '[data-icon="Layers"]'), false);
    view.unmount();
  });

  it('shows a description only when there is one', () => {
    const withText = render(
      createElement(NoteCard, { note: note(1, { description: 'About it' }) }),
    );
    assert.ok(withText.text().includes('About it'));
    withText.unmount();

    const without = render(createElement(NoteCard, { note: note(1) }));
    assert.equal(without.container.querySelectorAll('[data-text]').length >= 1, true);
    without.unmount();
  });

  it('speaks as one sentence naming the note and where it is', () => {
    const view = render(
      createElement(NoteCard, {
        note: note(1, { description: 'About it' }),
        location: 'Kitchen',
        onOpen: () => undefined,
      }),
    );
    const card =
      view.container.querySelector('[aria-label]') ?? view.container.querySelector('button');

    assert.equal(card.getAttribute('aria-label'), 'Note. Note 1. About it. In Kitchen');
    view.unmount();
  });

  it('is a plain surface with nowhere to go, and a button when there is', () => {
    // Manufacturing a handler regardless would give every card press feedback and a button role for
    // a no-op, which reads as a broken control to touch and screen-reader users alike.
    const plain = render(createElement(NoteCard, { note: note(1) }));
    assert.equal(has(plain.container, 'button'), false);
    plain.unmount();

    const openable = render(createElement(NoteCard, { note: note(1), onOpen: () => undefined }));
    assert.equal(has(openable.container, 'button'), true);
    openable.unmount();
  });

  it('opens by the server’s numeric id', () => {
    const opened = [];
    const view = render(
      createElement(NoteGrid, {
        items: [note(41), note(42)],
        onOpen: (id) => opened.push(id),
      }),
    );

    view.container.querySelector('[data-testid="note-card-42"]').click();
    assert.deepEqual(opened, [42]);
    view.unmount();
  });
});

describe('the order cards are read out in', () => {
  after(() => {
    setWindowDimensions({ width: 390, fontScale: 1 });
    setScreenReaderEnabled(false);
  });

  /**
   * Traversal follows the view tree, and the paired arrangement renders the whole left column before
   * the right - so four cards are walked 1, 3, 2, 4 while the eye reads 1, 2, 3, 4. React Native
   * exposes no cross-platform way to tell the platform otherwise, so the arrangement is what changes.
   */
  it('is the order they were given, once a screen reader is listening', async () => {
    setWindowDimensions({ width: 390, fontScale: 1 });
    setScreenReaderEnabled(true);

    const view = render(createElement(NoteGrid, { items: [note(1), note(2), note(3), note(4)] }));
    // The hook answers asynchronously, so the first paint is the two-column arrangement.
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(cardOrder(view.container), [
      'note-card-1',
      'note-card-2',
      'note-card-3',
      'note-card-4',
    ]);
    assert.equal(has(view.container, '[data-testid="note-grid-columns"]'), false);
    view.unmount();
    setScreenReaderEnabled(false);
  });

  it('is the order they were given when the columns collapse for room', () => {
    setWindowDimensions({ width: 390, fontScale: 1.5 });
    const view = render(createElement(NoteGrid, { items: [note(1), note(2), note(3), note(4)] }));

    assert.deepEqual(cardOrder(view.container), [
      'note-card-1',
      'note-card-2',
      'note-card-3',
      'note-card-4',
    ]);
    view.unmount();
  });
});

describe('the grid at large text', () => {
  after(() => {
    setWindowDimensions({ width: 390, fontScale: 1 });
    setScreenReaderEnabled(false);
  });

  it('pairs cards into columns at ordinary text size', () => {
    setWindowDimensions({ width: 390, fontScale: 1 });
    const view = render(createElement(NoteGrid, { items: [note(1), note(2), note(3), note(4)] }));

    assert.equal(has(view.container, '[data-testid="note-grid-columns"]'), true);
    view.unmount();
  });

  it('stacks them in one column when text is scaled up', () => {
    // Two columns of scaled text are two columns of one word each; stacking is also the only
    // arrangement whose reading order and visual order cannot disagree.
    setWindowDimensions({ width: 390, fontScale: 1.5 });
    const view = render(createElement(NoteGrid, { items: [note(1), note(2), note(3), note(4)] }));

    assert.equal(has(view.container, '[data-testid="note-grid-columns"]'), false);
    assert.equal(view.container.querySelectorAll('[data-testid^="note-card-"]').length, 4);
    view.unmount();
  });

  it('stacks them on a narrow window whatever the text size', () => {
    setWindowDimensions({ width: 320, fontScale: 1 });
    const view = render(createElement(NoteGrid, { items: [note(1), note(2)] }));

    assert.equal(has(view.container, '[data-testid="note-grid-columns"]'), false);
    view.unmount();
  });
});
