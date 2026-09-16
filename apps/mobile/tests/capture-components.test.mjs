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
const { setWindowDimensions } = await import('./support/stubs/react-native.mjs');
const { titleMaxHeight } = await import('../src/modules/capture/title.ts');
const { composerView } = await import('../src/modules/capture/composer.ts');
const { CaptureView } = await import('../src/modules/capture/components/CaptureView.tsx');
const { ProtectSheet } = await import('../src/modules/capture/components/ProtectSheet.tsx');
const { OutcomeSheet } = await import('../src/modules/capture/components/OutcomeSheet.tsx');
const { UnfinishedCard } = await import('../src/modules/capture/components/UnfinishedCard.tsx');
const { UnfinishedGridCard } =
  await import('../src/modules/capture/components/UnfinishedGridCard.tsx');
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

const composer = (over = {}) =>
  createElement(CaptureView, {
    title: 'Field notes',
    description: '',
    documentId: 'd1',
    document: { type: 'doc', content: [] },
    view: view(),
    destinationLabel: 'Work / Notes',
    destinationSpoken: 'Work / Notes',
    selection: { active: [], available: [] },
    onSelectionChange: () => {},
    onCommand: () => {},
    onTitleChange: () => {},
    onDescriptionChange: () => {},
    onSnapshot: () => {},
    onAction: () => {},
    onDestination: () => {},
    onClose: () => {},
    ...over,
  });

describe('the composer', () => {
  it('shows the status, the destination and one action', () => {
    const screen = render(composer());

    try {
      assert.equal(
        screen.byTestId('capture-status').textContent,
        'Kept on this phone as you write',
      );
      assert.equal(screen.byTestId('capture-destination').textContent, 'Work / Notes');
      assert.equal(screen.byTestId('capture-action').textContent, 'Save');
      // The title and the description are both there, and neither is behind a control.
      assert.ok(screen.byLabel('Note title') !== null);
      assert.ok(screen.byLabel('Description') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('speaks the whole path even though the chip shows two segments', () => {
    const screen = render(
      composer({ destinationLabel: '… / Work / Notes', destinationSpoken: 'Life / Work / Notes' }),
    );

    try {
      assert.equal(screen.byTestId('capture-destination').textContent, '… / Work / Notes');
      assert.ok(screen.byLabel('Filed in Life / Work / Notes') !== null);
    } finally {
      screen.unmount();
    }
  });

  it('asks where, rather than naming somewhere nobody chose', () => {
    const screen = render(composer({ destinationLabel: null, destinationSpoken: null }));

    try {
      assert.equal(screen.byTestId('capture-destination').textContent, 'Where?');
      assert.ok(screen.byLabel('Choose where this note goes') !== null);
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
      // The frozen request answers for this destination, so the chip cannot be changed.
      assert.equal(screen.byTestId('capture-destination').disabled, true);
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
  onHome: true,
  ...over,
});

describe('the cards for a note that is only on this phone', () => {
  it('carries its status where a saved note carries its location', () => {
    const screen = render(
      createElement(UnfinishedGridCard, { note: card(), now: T0 + 2 * 60 * 60 * 1000 }),
    );

    try {
      assert.ok(screen.text().includes('Draft · on this phone'));
      assert.ok(screen.text().includes('Edited 2 h ago'));
    } finally {
      screen.unmount();
    }
  });

  it('marks a draft with a dotted edge, and says the status in words as well', () => {
    const draft = render(createElement(UnfinishedGridCard, { note: card(), now: T0 }));
    const unresolved = render(
      createElement(UnfinishedGridCard, {
        note: card({ status: 'unresolved', key: 'draft:d2' }),
        now: T0,
      }),
    );

    try {
      assert.ok(draft.host.innerHTML.includes('border-dotted'));
      // Status is never carried by colour alone: both cards say it.
      assert.ok(unresolved.text().includes('Save not confirmed'));
      assert.ok(!unresolved.host.innerHTML.includes('border-dotted'));
    } finally {
      draft.unmount();
      unresolved.unmount();
    }
  });

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
