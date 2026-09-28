/**
 * The surfaces a person sees while writing, rendered: the composer's states, the editor's conflict
 * band, Unfinished's rows and the offline screen.
 *
 * The components are mounted with props rather than through their routes: what is pinned is that a
 * state is drawn as the accepted design says. What a real keyboard, WebView or screen reader does
 * with the same props is device evidence and is not claimed here.
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
const { Alert, setWindowDimensions } = await import('./support/stubs/react-native.mjs');
const { titleMaxHeight } = await import('../src/modules/capture/title.ts');
const { createStatus, destinationEyebrow, detailsChip, saveLabel } =
  await import('../src/modules/capture/copy.ts');
const { CaptureView } = await import('../src/modules/capture/components/CaptureView.tsx');
const { ConflictBand } = await import('../src/modules/capture/components/ConflictBand.tsx');
const { UnfinishedList } = await import('../src/modules/capture/components/UnfinishedList.tsx');
const { OfflineScreen } = await import('../src/modules/connection/components/OfflineScreen.tsx');
const { ListRow } = await import('../src/ui/core/ListRow.tsx');
const { SelectableTree } = await import('../src/modules/browse/components/SelectableTree.tsx');

/**
 * Put text into a field the way a person does.
 *
 * React tracks a controlled input's value on the node itself, so assigning `.value` directly is
 * ignored as a no-op. Going through the prototype's own setter is what makes the change real.
 */
const type = (field, text) => {
  const prototype =
    field.tagName === 'TEXTAREA'
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};

const render = (element) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  return {
    host,
    text: () => host.textContent ?? '',
    byLabel: (label) => host.querySelector(`[aria-label="${label}"]`),
    labels: () =>
      [...host.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
    byTestId: (id) => host.querySelector(`[data-testid="${id}"]`),
    press: (label) => {
      const control = host.querySelector(`[aria-label="${label}"]`);
      assert.ok(control !== null, `no control called ${label}`);
      act(() => {
        control.click();
      });
    },
    pressTestId: (id) => {
      const control = host.querySelector(`[data-testid="${id}"]`);
      assert.ok(control !== null, `no control at ${id}`);
      act(() => {
        control.click();
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

/** The destination exactly as the screen composes it: from a name, never assembled by hand. */
const named = (over = {}) =>
  destinationEyebrow({ chip: 'Work / Notes', spoken: 'Work / Notes', leaf: 'Notes', ...over });

const composer = ({ standing = { kind: 'draft', problem: null }, saving = false, ...over } = {}) =>
  createElement(CaptureView, {
    title: 'Field notes',
    description: '',
    documentId: 'd1',
    document: { type: 'doc', content: [] },
    status: createStatus(saving ? { kind: 'saving' } : standing),
    action: {
      label: saveLabel(saving ? { kind: 'saving' } : standing),
      enabled:
        !saving &&
        (standing.kind === 'retrying' || standing.kind !== 'draft' || standing.problem === null),
    },
    saving,
    destination: named(),
    details: detailsChip({ nodeType: 'resource', kind: 'note', slug: null, tagCount: 0 }),
    selection: { active: [], available: [] },
    onSelectionChange: () => {},
    onCommand: () => {},
    onTitleChange: () => {},
    onDescriptionChange: () => {},
    onSnapshot: () => {},
    onSave: () => {},
    onDestination: () => {},
    onDetails: () => {},
    onClose: () => {},
    ...over,
  });

/** Presses the destructive button of the last confirmation asked for, and lets it resolve. */
const confirmLast = async () => {
  const [, , buttons] = Alert.calls.at(-1);

  act(() => {
    buttons.find((button) => button.style === 'destructive').onPress();
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

describe('the composer', () => {
  it('shows the status, the destination above the title, and one action', () => {
    const screen = render(composer());

    try {
      assert.equal(screen.byTestId('capture-status').textContent, 'Draft · on this phone');
      // The destination is the eyebrow now, in the same slot where an existing entity names where
      // it is filed. The bar carries the Details chip and the Save pill, and no location chip.
      assert.equal(screen.byTestId('capture-eyebrow').textContent, 'Work / Notes');
      assert.equal(screen.byTestId('capture-details').textContent, 'Tags');
      assert.equal(screen.byTestId('capture-action').textContent, 'Save');
      assert.equal(screen.byTestId('capture-destination'), null, 'the "Where?" chip is gone');
      // The title and the description are both there, and neither is behind a control.
      assert.ok(screen.byLabel('Note title') !== null);
      assert.ok(screen.byLabel('Description') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('opens the destination sheet from the eyebrow', () => {
    const presses = [];
    const screen = render(
      composer({
        onDestination: () => {
          presses.push(true);
        },
      }),
    );

    try {
      screen.pressTestId('capture-eyebrow');
      assert.deepEqual(presses, [true]);
    } finally {
      screen.unmount();
    }
  });

  it('opens the details sheet from the bar', () => {
    const presses = [];
    const screen = render(
      composer({
        onDetails: () => {
          presses.push(true);
        },
      }),
    );

    try {
      screen.pressTestId('capture-details');
      assert.deepEqual(presses, [true]);
    } finally {
      screen.unmount();
    }
  });

  it('speaks the whole path even though the eyebrow shows two segments', () => {
    const screen = render(
      composer({ destination: named({ chip: '… / Work / Notes', spoken: 'Life / Work / Notes' }) }),
    );

    try {
      assert.equal(screen.byTestId('capture-eyebrow').textContent, '… / Work / Notes');
      assert.ok(screen.byLabel('Filed in Life / Work / Notes') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('asks where, rather than naming somewhere nobody chose, and holds Save until it is told', () => {
    const screen = render(
      composer({
        destination: named({ chip: null, spoken: null, leaf: null }),
        standing: { kind: 'draft', problem: 'destination' },
      }),
    );

    try {
      assert.equal(screen.byTestId('capture-eyebrow').textContent, 'Where does this go?');
      assert.ok(screen.byLabel('Choose where this note goes') !== null);
      assert.equal(screen.byTestId('capture-action').disabled, true);
      assert.equal(
        screen.byTestId('capture-status').textContent,
        'Draft · choose where it goes to save',
      );
    } finally {
      screen.unmount();
    }
  });

  /**
   * The chosen-but-unnameable state is its own thing, and it survived the move off the bar.
   *
   * A destination the hierarchy cannot name right now is still chosen. Reverting to the question
   * would invite someone to pick again over a choice that still stands, which is the rule
   * `useDestinationName` states and the eyebrow now has to keep.
   */
  it('does not ask again about a place it simply cannot name', () => {
    const screen = render(
      composer({ destination: named({ chip: 'Chosen place', spoken: null, leaf: null }) }),
    );

    try {
      assert.equal(screen.byTestId('capture-eyebrow').textContent, 'Chosen place');
      assert.ok(!screen.text().includes('Where does this go?'));
      // Spoken as what it is. Never "Filed in Chosen place", which would read as a place's name, and
      // never a sentence interpolated into another one.
      assert.ok(
        screen.byLabel('Where this note goes, which your server has not named here yet') !== null,
      );
    } finally {
      screen.unmount();
    }
  });

  it('says how many tags a note that does not exist yet has', () => {
    const chip = (tagCount) =>
      detailsChip({ nodeType: 'resource', kind: 'note', slug: null, tagCount });

    // No ID to show, because the server derives one from the title only once the note exists.
    assert.equal(chip(0).label, 'Tags');
    assert.equal(chip(0).spoken, 'Details: no tags');
    assert.equal(chip(1).label, '1 tag');
    assert.equal(chip(3).label, '3 tags');
    assert.equal(chip(3).spoken, 'Details: 3 tags');

    const screen = render(composer({ details: chip(2) }));

    try {
      assert.equal(screen.byTestId('capture-details').textContent, '2 tags');
    } finally {
      screen.unmount();
    }
  });

  it('says it is saving, and holds every field, the destination and Close while it does', () => {
    const screen = render(composer({ saving: true }));

    try {
      assert.equal(screen.byTestId('capture-status').textContent, 'Saving…');
      assert.equal(screen.byTestId('capture-action').textContent, 'Saving…');
      assert.equal(screen.byTestId('capture-action').disabled, true);
      assert.equal(screen.byTestId('capture-eyebrow').getAttribute('aria-disabled'), 'true');
      assert.equal(screen.byTestId('capture-close').getAttribute('aria-disabled'), 'true');
    } finally {
      screen.unmount();
    }
  });

  it('says it will retry, quietly, and offers Try now', () => {
    const screen = render(composer({ standing: { kind: 'retrying' } }));

    try {
      const status = screen.byTestId('capture-status');

      assert.equal(status.textContent, 'Couldn’t save · will retry');
      assert.ok(!status.className.includes('text-danger'), 'nothing is wrong with the writing');
      assert.equal(screen.byTestId('capture-action').textContent, 'Try now');
      assert.notEqual(screen.byTestId('capture-action').disabled, true);
    } finally {
      screen.unmount();
    }
  });

  it('says the server’s reason for a refusal, in the error colour', () => {
    const screen = render(
      composer({
        standing: { kind: 'refused', message: 'The parent is inside something archived.' },
      }),
    );

    try {
      const status = screen.byTestId('capture-status');

      assert.equal(status.textContent, 'Not saved: The parent is inside something archived.');
      assert.ok(status.className.includes('text-danger'));
      assert.equal(screen.byTestId('capture-action').textContent, 'Save');
    } finally {
      screen.unmount();
    }
  });

  it('asks for writing before it will save', () => {
    const screen = render(composer({ standing: { kind: 'draft', problem: 'writing' } }));

    try {
      assert.equal(
        screen.byTestId('capture-status').textContent,
        'Draft · add a title or some writing to save',
      );
      assert.equal(screen.byTestId('capture-action').disabled, true);
    } finally {
      screen.unmount();
    }
  });

  it('turns a pasted line break into a space before the owner is told anything', () => {
    const typed = [];
    const screen = render(
      composer({
        onTitleChange: (value) => {
          typed.push(value);
        },
      }),
    );

    try {
      // What a paste looks like from the component's side: one change carrying the break.
      type(screen.byLabel('Note title'), 'Field\r\nnotes');

      assert.deepEqual(typed, ['Field notes'], 'the owner never sees the break');
    } finally {
      screen.unmount();
    }
  });

  it('gives the title two lines at the reader’s own text size, not at the default one', () => {
    setWindowDimensions({ fontScale: 2 });
    const screen = render(composer());

    try {
      const cap = Number(screen.byLabel('Note title').getAttribute('data-max-height'));

      // A fixed cap is two lines only at the default scale, and clipped the second line for
      // exactly the people who had asked for larger text.
      assert.equal(cap, titleMaxHeight(2));
      assert.ok(cap > titleMaxHeight(1));
    } finally {
      screen.unmount();
      setWindowDimensions({ fontScale: 1 });
    }
  });

  it('keeps the formatting row out of the way until the body is where writing is going', () => {
    const screen = render(composer());

    try {
      assert.equal(screen.byLabel('Bold'), null, 'nothing is formatted before the body has focus');
    } finally {
      screen.unmount();
    }
  });
});

describe('the conflict band', () => {
  it('says what happened, and asks before each way out', async () => {
    const chosen = [];
    const screen = render(
      createElement(ConflictBand, {
        onTakeServers: () => chosen.push('servers'),
        onKeepMine: () => chosen.push('mine'),
      }),
    );

    Alert.calls.length = 0;

    try {
      assert.ok(
        screen
          .text()
          .includes('This changed on your server while you were editing. Which version stays?'),
      );

      screen.press('Take server’s');
      assert.deepEqual(chosen, [], 'nothing happens on the press alone');
      assert.equal(Alert.calls.at(-1)[0], 'Discard your changes?');
      await confirmLast();

      screen.press('Keep mine');
      assert.equal(Alert.calls.at(-1)[0], 'Replace the version on your server?');
      await confirmLast();

      assert.deepEqual(chosen, ['servers', 'mine']);
    } finally {
      screen.unmount();
    }
  });
});

describe('Unfinished', () => {
  const item = (standing, over = {}) => ({
    key: standing,
    mark: { kind: 'note', id: 1 },
    title: `A ${standing} note`,
    standing,
    ...over,
  });

  it('draws one line per row: the state, then where it lives or why it was refused', () => {
    const screen = render(
      createElement(UnfinishedList, {
        items: [
          item('draft', { detail: 'Notes' }),
          item('waiting', { detail: 'Notes' }),
          item('refused', { detail: '"idea" is already used here.' }),
          item('conflict'),
        ],
        onOpen: () => {},
        onDiscard: () => {},
      }),
    );

    try {
      const text = screen.text();

      assert.ok(text.includes('Writing that hasn’t reached your server yet.'));
      assert.ok(text.includes('Draft · Notes'));
      assert.ok(text.includes('Waiting to sync · Notes'));
      assert.ok(text.includes('Not saved · "idea" is already used here.'));
      assert.ok(text.includes('Changed on your server'));
    } finally {
      screen.unmount();
    }
  });

  it('opens a row, and discards only after asking, never while it is being sent', async () => {
    const opened = [];
    const discarded = [];
    const screen = render(
      createElement(UnfinishedList, {
        items: [item('draft'), item('waiting')],
        onOpen: (row) => opened.push(row.key),
        onDiscard: (row) => discarded.push(row.key),
      }),
    );

    Alert.calls.length = 0;

    try {
      screen.press('A draft note, Draft');
      assert.deepEqual(opened, ['draft']);

      assert.equal(screen.byLabel('Discard A waiting note').getAttribute('aria-disabled'), 'true');

      screen.press('Discard A draft note');
      assert.equal(Alert.calls.at(-1)[0], 'Discard this draft?');
      assert.deepEqual(discarded, []);
      await confirmLast();
      assert.deepEqual(discarded, ['draft']);
    } finally {
      screen.unmount();
    }
  });

  it('says when there is nothing unfinished', () => {
    const screen = render(
      createElement(UnfinishedList, { items: [], onOpen: () => {}, onDiscard: () => {} }),
    );

    try {
      assert.ok(screen.text().includes('Nothing unfinished.'));
    } finally {
      screen.unmount();
    }
  });
});

describe('a list row', () => {
  it('carries a detail after its label, and pulses the label while pending', () => {
    const screen = render(
      createElement(ListRow, {
        title: 'Field notes',
        kindLabel: 'Waiting to sync',
        detail: 'Notes',
        pending: true,
        mark: { kind: 'note', id: 1 },
        onPress: () => {},
      }),
    );

    try {
      assert.ok(screen.text().includes('Waiting to sync · Notes'));
    } finally {
      screen.unmount();
    }
  });
});

describe('the offline screen', () => {
  const offline = (over = {}) =>
    createElement(OfflineScreen, {
      origin: 'https://pi.local',
      checking: false,
      secondsUntilCheck: 7,
      onTryNow: () => {},
      onChangeServer: () => {},
      ...over,
    });

  it('names the server, counts down to the next check, and offers Try now and Change', () => {
    const pressed = [];
    const screen = render(
      offline({
        onTryNow: () => pressed.push('try'),
        onChangeServer: () => pressed.push('change'),
      }),
    );

    try {
      assert.ok(screen.text().includes('Can’t reach your server.'));
      assert.ok(screen.text().includes('https://pi.local'));
      assert.ok(screen.text().includes('Checking again in 7 s'));

      screen.press('Try now');
      screen.press('Change');
      assert.deepEqual(pressed, ['try', 'change']);
    } finally {
      screen.unmount();
    }
  });

  it('says it is checking while a check is out', () => {
    const screen = render(offline({ checking: true }));

    try {
      assert.ok(screen.text().includes('Checking…'));
      assert.ok(!screen.text().includes('Checking again in'));
    } finally {
      screen.unmount();
    }
  });
});

describe('the tree a destination is chosen from', () => {
  const node = (id, title, children = []) => ({
    id,
    type: children.length > 0 ? 'area' : 'project',
    parentId: null,
    slug: title.toLowerCase(),
    title,
    description: '',
    children,
  });

  it('draws rows as radios and marks the one that is chosen', () => {
    const picked = [];
    const screen = render(
      createElement(SelectableTree, {
        nodes: [node(1, 'Work', [node(2, 'Notes')])],
        selected: { type: 'project', id: 2 },
        expandedIds: new Set([1]),
        forceExpanded: false,
        onToggle: () => {},
        onSelect: (chosen) => picked.push(chosen.id),
      }),
    );

    try {
      const chosen = screen.byLabel('Notes');
      assert.equal(chosen.getAttribute('aria-selected'), 'true');
      assert.equal(screen.byLabel('Work').getAttribute('aria-selected'), 'false');
      // Picking a place is not going there.
      screen.press('Work');
      assert.deepEqual(picked, [1]);
      // Browse's own affordances are not on this tree.
      assert.equal(screen.byLabel('Add inside Work'), null);
      assert.equal(screen.byLabel('New area'), null);
    } finally {
      screen.unmount();
    }
  });
});
