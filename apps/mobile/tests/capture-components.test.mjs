/**
 * The capture surfaces a person actually sees, rendered.
 *
 * `composer.test.mjs` settles what the bar *is* for a state; this settles that the screen built on
 * it shows that state - which is a different claim and the one that breaks quietly. A screen can
 * derive a perfectly correct view and then draw the wrong control from it.
 *
 * The route itself is deliberately not mounted. It is this view plus an owner, a router and a
 * connection store, and standing all of that up would test the substitutes rather than the product;
 * what the route owns beyond these components is exercised over the real owner in
 * `capture-production.test.mjs`. What a real keyboard, a real WebView and a real screen reader do
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
const { composerView, destinationEyebrow } = await import('../src/modules/capture/composer.ts');
const { CONFLICT_NOTICE, detailsChip } = await import('../src/modules/capture/edit-composer.ts');
const { CaptureView } = await import('../src/modules/capture/components/CaptureView.tsx');
const { ProtectSheet } = await import('../src/modules/capture/components/ProtectSheet.tsx');
const { OutcomeSheet } = await import('../src/modules/capture/components/OutcomeSheet.tsx');
const { UnfinishedCard } = await import('../src/modules/capture/components/UnfinishedCard.tsx');
const { UnfinishedEditCard } =
  await import('../src/modules/capture/components/UnfinishedEditCard.tsx');
const { SelectableTree } = await import('../src/modules/browse/components/SelectableTree.tsx');

const T0 = 1_700_000_000_000;

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

const view = (over = {}) =>
  composerView({
    standing: { kind: 'save' },
    protection: {
      committedVersion: 1,
      latestAcceptedVersion: 1,
      pending: false,
      writing: false,
      failedWrite: false,
      rendererUnknown: false,
      locked: false,
      attached: true,
    },
    lastRejection: null,
    saving: false,
    hasContent: true,
    hasDestination: true,
    revision: null,
    hasRemainder: false,
    ...over,
  });

/** The destination exactly as the screen composes it: from a name, never assembled by hand. */
const named = (over = {}) =>
  destinationEyebrow({ chip: 'Work / Notes', spoken: 'Work / Notes', leaf: 'Notes', ...over });

const composer = (over = {}) =>
  createElement(CaptureView, {
    title: 'Field notes',
    description: '',
    documentId: 'd1',
    document: { type: 'doc', content: [] },
    view: view(),
    destination: named(),
    details: detailsChip({ nodeType: 'resource', kind: 'note', slug: null, tagCount: 0 }),
    selection: { active: [], available: [] },
    onSelectionChange: () => {},
    onCommand: () => {},
    onTitleChange: () => {},
    onDescriptionChange: () => {},
    onSnapshot: () => {},
    onAction: () => {},
    onDestination: () => {},
    onDetails: () => {},
    onClose: () => {},
    ...over,
  });

describe('the composer', () => {
  it('shows the status, the destination above the title, and one action', () => {
    const screen = render(composer());

    try {
      assert.equal(
        screen.byTestId('capture-status').textContent,
        'Kept on this phone as you write',
      );
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
        view: view({ hasDestination: false }),
      }),
    );

    try {
      assert.equal(screen.byTestId('capture-eyebrow').textContent, 'Where does this go?');
      assert.ok(screen.byLabel('Choose where this note goes') !== null);
      assert.equal(screen.byTestId('capture-action').disabled, true);
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

  it('says what is unprotected, in the error colour, with Save unavailable', () => {
    const screen = render(
      composer({
        view: view({
          protection: {
            committedVersion: 1,
            latestAcceptedVersion: 2,
            pending: false,
            writing: false,
            failedWrite: true,
            rendererUnknown: false,
            locked: false,
            attached: true,
          },
        }),
      }),
    );

    try {
      const status = screen.byTestId('capture-status');
      assert.ok(status.textContent.startsWith('Not protected'));
      assert.ok(status.className.includes('text-danger'), 'the status turns to the error colour');
      assert.equal(screen.byTestId('capture-action').disabled, true);
    } finally {
      screen.unmount();
    }
  });

  it('shows Retry rather than Save for a save that was never answered', () => {
    const attempt = { attemptId: 'a1', clockAnomaly: false, lastOutcome: null };
    const screen = render(composer({ view: view({ standing: { kind: 'retry', attempt } }) }));

    try {
      assert.equal(screen.byTestId('capture-action').textContent, 'Retry');
      // The frozen request answers for this destination, so it is no longer a choice - and it says
      // so by becoming the label an existing entity draws, not a button that can never succeed.
      const eyebrow = screen.byTestId('capture-eyebrow');

      assert.equal(eyebrow.textContent, 'Work / Notes');
      assert.equal(eyebrow.getAttribute('role'), null, 'no longer a button');
      assert.equal(eyebrow.getAttribute('aria-disabled'), null);
    } finally {
      screen.unmount();
    }
  });

  /**
   * Locked and frozen are different facts, and a disabled control is a promise.
   *
   * A request in the air comes back, so the eyebrow stays a button and says it is unavailable. A
   * request that has answered never gives the choice back: the note is on the server at that place,
   * and moving it from there is a move, made from the edit screen's eyebrow.
   */
  it('keeps the eyebrow a disabled button only while a request is in the air', () => {
    const screen = render(composer({ view: view({ saving: true }) }));

    try {
      const eyebrow = screen.byTestId('capture-eyebrow');

      assert.equal(eyebrow.getAttribute('role'), 'button');
      assert.equal(eyebrow.getAttribute('aria-disabled'), 'true');
    } finally {
      screen.unmount();
    }
  });

  it('offers nothing at all when the bar has no honest action', () => {
    const attempt = { attemptId: 'a1', clockAnomaly: false, lastOutcome: null };
    const screen = render(
      composer({
        view: view({ standing: { kind: 'blocked', reason: 'created', attempt }, revision: 2 }),
      }),
    );

    try {
      assert.equal(screen.byTestId('capture-action'), null);
      assert.equal(screen.byTestId('capture-status').textContent, 'On your server · revision 2');
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

describe('the sheet that will not let unprotected writing leave', () => {
  it('offers the repair, keeping on, and an explicit discard', () => {
    const pressed = [];
    const screen = render(
      createElement(ProtectSheet, {
        visible: true,
        problem: 'failed_write',
        canUndo: false,
        onRepair: () => pressed.push('repair'),
        onKeepEditing: () => pressed.push('keep'),
        onDiscard: () => pressed.push('discard'),
      }),
    );

    try {
      screen.press('Try writing it again');
      screen.press('Keep editing');
      screen.press('Discard this note');
      assert.deepEqual(pressed, ['repair', 'keep', 'discard']);
    } finally {
      screen.unmount();
    }
  });

  it('says that repairing keeps the note and that discarding deletes it', () => {
    const screen = render(
      createElement(ProtectSheet, {
        visible: true,
        problem: 'failed_write',
        canUndo: false,
        onRepair: () => {},
        onKeepEditing: () => {},
        onDiscard: () => {},
      }),
    );

    try {
      const text = screen.text();

      assert.ok(text.includes('Repairing acts on the last change only; the note stays.'));
      assert.ok(text.includes('Discarding deletes the note and everything written in it.'));
      // Never "discard changes": the destructive action deletes the note, and the label says so.
      assert.ok(screen.byLabel('Discard this note') !== null);
      assert.equal(screen.byLabel('Discard changes'), null);
    } finally {
      screen.unmount();
    }
  });

  it('says what discarding keeps when a save was never answered', () => {
    const screen = render(
      createElement(ProtectSheet, {
        visible: true,
        problem: 'failed_write',
        canUndo: false,
        hasUnresolvedEvidence: true,
        onRepair: () => {},
        onKeepEditing: () => {},
        onDiscard: () => {},
      }),
    );

    try {
      const text = screen.text();

      // Throwing writing away cannot un-ask a question, and someone giving up on a note must not be
      // left believing they have cancelled a creation the server may have made.
      assert.ok(text.includes('keeps its record of the save it could not confirm'));
      assert.ok(
        screen
          .byLabel('Discard this note')
          .getAttribute('aria-description')
          .includes('could not confirm'),
      );
    } finally {
      screen.unmount();
    }
  });

  it('does not promise an undo it cannot perform', () => {
    const screen = render(
      createElement(ProtectSheet, {
        visible: true,
        problem: 'too_large',
        canUndo: false,
        onRepair: () => {},
        onKeepEditing: () => {},
        onDiscard: () => {},
      }),
    );

    try {
      assert.equal(screen.byLabel('Undo the last change'), null);
      // What is left is honest: stay and cut it down, or give it up deliberately.
      assert.ok(screen.byLabel('Keep editing') !== null);
      assert.ok(screen.byLabel('Discard this note') !== null);
    } finally {
      screen.unmount();
    }
  });
});

describe('the outcome sheets', () => {
  it('says a refusal plainly, with one way back to the note', () => {
    const screen = render(
      createElement(OutcomeSheet, {
        visible: true,
        kind: 'refused',
        message: 'Your server needs a title for this one.',
        destination: 'Notes',
        onClose: () => {},
      }),
    );

    try {
      assert.ok(screen.text().includes('Not saved'));
      assert.ok(screen.text().includes('Your server needs a title for this one.'));
      assert.ok(screen.byLabel('Try the same save again') === null);
    } finally {
      screen.unmount();
    }
  });

  it('never claims nothing was created when the answer was lost', () => {
    const screen = render(
      createElement(OutcomeSheet, {
        visible: true,
        kind: 'uncertain',
        message: '',
        detail:
          'Your server refused the latest try: no. That answers for the try, not for the first request.',
        destination: 'Notes',
        onClose: () => {},
        onRetry: () => {},
        onLookIn: () => {},
      }),
    );

    try {
      const text = screen.text();
      assert.ok(text.includes('cannot tell whether this saved'));
      assert.ok(!text.includes('Not saved'));
      // The latest refusal is reported as what it is, and Retry stays.
      assert.ok(text.includes('That answers for the try, not for the first request.'));
      assert.ok(screen.byLabel('Try the same save again') !== null);
      assert.ok(screen.byLabel('Look in Notes') !== null);
    } finally {
      screen.unmount();
    }
  });
});

const card = (over = {}) => ({
  key: 'draft:d1',
  draftId: 'd1',
  attemptId: null,
  status: 'draft',
  group: 3,
  title: 'Field notes',
  description: '',
  destination: { type: 'area', id: 3 },
  endpoint: 'https://raphael.example',
  scope: 'current',
  activityAt: T0,
  sending: false,
  server: null,
  withdrawn: null,
  actions: ['open', 'discard'],
  ...over,
});

describe('the cards for a note that is only on this phone', () => {
  it('offers only what the projection permits', () => {
    const screen = render(
      createElement(UnfinishedCard, {
        note: card({ status: 'unresolved', actions: ['open', 'look_in', 'copy', 'discard'] }),
        now: T0,
        destination: 'Notes',
        actions: {
          open: () => {},
          lookIn: () => {},
          copy: () => {},
          discard: () => {},
          recordAgain: () => {},
        },
      }),
    );

    try {
      assert.ok(screen.byLabel('Open') !== null);
      assert.ok(screen.byLabel('Look in Notes') !== null);
      assert.ok(screen.byLabel('Copy into a new note') !== null);
      // The host can do it, but this row must not offer it: there is no acknowledgement to rewrite.
      assert.ok(screen.byLabel('Record it again') === null);
    } finally {
      screen.unmount();
    }
  });

  it('says where work from another server came from, and offers nothing that needs one', () => {
    const screen = render(
      createElement(UnfinishedCard, {
        note: card({ scope: 'retired', actions: ['copy', 'discard'] }),
        now: T0,
        actions: { open: () => {}, copy: () => {}, discard: () => {}, lookIn: () => {} },
      }),
    );

    try {
      assert.ok(screen.text().includes('https://raphael.example'));
      assert.ok(screen.byLabel('Open') === null);
      assert.ok(screen.byLabel('Copy into a new note') !== null);
      // The old instruction to reconnect and resend is gone: nothing is ever rebound by endpoint.
      assert.ok(!screen.text().includes('Connect to it to send it again'));
    } finally {
      screen.unmount();
    }
  });

  it('never describes an unresolved save as not created', () => {
    const screen = render(
      createElement(UnfinishedCard, {
        note: card({
          status: 'unresolved_withdrawn',
          withdrawn: 'window_ended',
          actions: ['copy'],
        }),
        now: T0,
        actions: { copy: () => {} },
      }),
    );

    try {
      const text = screen.text();
      assert.ok(text.includes('never heard back'));
      assert.ok(text.includes('look in the destination'));
      assert.ok(!text.includes('created nothing'));
    } finally {
      screen.unmount();
    }
  });
});

const editRow = (over = {}) => ({
  key: 'edit:c1/12',
  editKey: 'c1/12',
  nodeId: 12,
  nodeType: 'resource',
  kind: 'note',
  title: 'Autosave loop notes',
  standing: 'pending',
  refusal: null,
  endpoint: 'https://raphael.example',
  scope: 'current',
  activityAt: T0,
  actions: ['open', 'discard'],
  ...over,
});

describe('the cards for changes that are not on the server', () => {
  it('says what it is, when it was touched, and what is true of it now', () => {
    const screen = render(
      createElement(UnfinishedEditCard, {
        edit: editRow(),
        now: T0 + 2 * 60 * 60 * 1000,
      }),
    );

    try {
      assert.ok(screen.text().includes('Note · 2 h ago'));
      assert.ok(screen.text().includes('Autosave loop notes'));
      assert.ok(screen.text().includes('kept on this phone'));
      // The two states nobody has to act on never claim work that is not running.
      assert.ok(!screen.text().includes('saving soon'));
      assert.ok(!screen.text().includes('checking your server'));
    } finally {
      screen.unmount();
    }
  });

  it('carries the reason the server gave, rather than the sentence for an unreadable one', () => {
    const screen = render(
      createElement(UnfinishedEditCard, {
        edit: editRow({
          standing: 'refused',
          refusal: { code: 'slug_conflict', field: 'slug', reason: null, at: T0 },
        }),
        now: T0,
      }),
    );

    try {
      assert.ok(screen.text().includes('that note ID is already used'));
    } finally {
      screen.unmount();
    }
  });

  it('says the same thing about a conflict that the editor’s band says', () => {
    const screen = render(
      createElement(UnfinishedEditCard, { edit: editRow({ standing: 'conflicted' }), now: T0 }),
    );

    try {
      assert.ok(screen.text().includes(CONFLICT_NOTICE));
    } finally {
      screen.unmount();
    }
  });

  it('claims no title and no time for a row whose columns could not be read', () => {
    const screen = render(
      createElement(UnfinishedEditCard, {
        edit: editRow({
          key: 'unusable-edit:c1/12',
          nodeType: null,
          kind: null,
          title: '',
          standing: 'unusable',
          problem: 'unsupported_content_schema',
          activityAt: 0,
          actions: ['discard'],
        }),
        now: T0,
        onDiscard: () => undefined,
        onOpen: () => undefined,
      }),
    );

    try {
      const text = screen.text();

      assert.ok(text.startsWith('Changes'), 'no type it could not read, and no invented one');
      assert.ok(!text.includes('ago'), 'and no time it cannot support');
      assert.ok(!text.includes('Untitled'));
      assert.ok(text.includes('kept exactly as they are'));
      // Open is withheld by the projection, and the card offers exactly what it was given.
      assert.equal(screen.byLabel('Open'), null);
      assert.ok(screen.byLabel('Discard') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('asks before discarding, and says the server is not touched', () => {
    const discarded = [];
    const screen = render(
      createElement(UnfinishedEditCard, {
        edit: editRow({ standing: 'conflicted' }),
        now: T0,
        onDiscard: (row) => {
          discarded.push(row.editKey);
        },
      }),
    );

    Alert.calls.length = 0;

    try {
      screen.press('Discard');
      assert.equal(Alert.calls.length, 1, 'nothing is removed on the press alone');
      assert.deepEqual(discarded, []);

      const [title, message, buttons] = Alert.calls[0];

      assert.equal(title, 'Discard your changes?');
      assert.ok(message.includes('What is on your server stays as it is.'));

      const discard = buttons.find((button) => button.style === 'destructive');

      act(() => {
        discard.onPress();
      });
    } finally {
      screen.unmount();
    }

    // The confirmation resolves a promise, so the call lands on the next turn.
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.deepEqual(discarded, ['c1/12']);
        resolve();
      }, 0);
    });
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
