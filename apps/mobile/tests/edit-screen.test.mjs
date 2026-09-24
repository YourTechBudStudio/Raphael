/**
 * The editing surfaces a person actually sees, rendered.
 *
 * `edit-composer.test.mjs` settles what the bar *is* for a standing; this settles that the screen
 * built on it draws that standing - which is a different claim and the one that breaks quietly. A
 * screen can derive a perfectly correct view and then draw the wrong control from it.
 *
 * The route and its composition are deliberately not mounted, exactly as the capture components are
 * not: `EditScreen` is this view plus an owner, a router, a hierarchy query and a connection store,
 * and standing all of that up would test the substitutes. What the composition owns beyond these
 * components is exercised over the real owner in `edit-owner.test.mjs` and `cross-client.test.mjs`.
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
const {
  detailsChip,
  editComposerView,
  moveControl,
  CONFLICT_NOTICE,
  CONFLICTED_STATUS,
  MOVE_EYEBROW_HINT,
  MOVE_LOCKED_HINT,
  MOVE_UNCONFIRMED_HINT,
} = await import('../src/modules/capture/edit-composer.ts');
const { EditView } = await import('../src/modules/capture/components/EditView.tsx');
const { DetailsSheet } = await import('../src/modules/capture/components/DetailsSheet.tsx');
const { EntityUnavailable } =
  await import('../src/modules/capture/components/EntityUnavailable.tsx');
const { ContainerEditAction } =
  await import('../src/modules/collections/components/ContainerEditAction.tsx');

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

const PROTECTED = {
  committedVersion: 1,
  latestAcceptedVersion: 1,
  pending: false,
  writing: false,
  failedWrite: false,
  rendererUnknown: false,
  locked: false,
  attached: true,
};

/** The view exactly as the screen derives it: from a standing, never assembled by hand. */
const viewFor = (standing, over = {}) =>
  editComposerView({
    standing,
    protection: PROTECTED,
    lastRejection: null,
    nodeType: 'resource',
    kind: 'note',
    ...over,
  });

const editor = (over = {}) =>
  createElement(EditView, {
    title: 'Autosave loop notes',
    description: 'How edits reach the server.',
    documentId: 'c1/42',
    document: { type: 'doc', content: [] },
    view: viewFor({ kind: 'synced', revision: 7 }),
    location: ['Raphael', 'Sync notes'],
    details: detailsChip({
      nodeType: 'resource',
      kind: 'note',
      slug: 'autosave-loop-notes',
      tagCount: 3,
    }),
    leaving: false,
    move: null,
    selection: { active: [], available: [] },
    onSelectionChange: () => {},
    onCommand: () => {},
    onTitleChange: () => {},
    onDescriptionChange: () => {},
    onSnapshot: () => {},
    onDetails: () => {},
    onDiscard: () => {},
    onClose: () => {},
    ...over,
  });

describe('the editor over an existing entity', () => {
  it('says where it stands, names where it is filed, and offers Details and Move', () => {
    let moves = 0;
    const screen = render(
      editor({
        move: {
          ...moveControl({
            locationKnown: true,
            locked: false,
            leaving: false,
            moveInflight: false,
          }),
          onPress: () => {
            moves += 1;
          },
        },
      }),
    );

    try {
      assert.equal(screen.byTestId('edit-status').textContent, 'On your server · revision 7');
      assert.equal(screen.byTestId('edit-details').textContent, 'autosave-loop-notes · 3 tags');
      // The location eyebrow, in the slot where a new note offers a destination, is the Move control.
      const eyebrow = screen.byTestId('edit-eyebrow');

      assert.ok(eyebrow.textContent.includes('Raphael / Sync notes'));
      assert.equal(eyebrow.getAttribute('role'), 'button');
      assert.equal(eyebrow.getAttribute('aria-description'), MOVE_EYEBROW_HINT);
      assert.notEqual(eyebrow.getAttribute('aria-disabled'), 'true');
      screen.pressTestId('edit-eyebrow');
      assert.equal(moves, 1);
      // No Save on an existing entity, and no destination picker of the new-note kind.
      assert.equal(screen.byTestId('capture-action'), null);
      assert.equal(screen.byTestId('capture-destination'), null);
    } finally {
      screen.unmount();
    }
  });

  it('keeps the eyebrow a label where there is no Move to offer', () => {
    const screen = render(editor({ move: null }));

    try {
      const eyebrow = screen.byTestId('edit-eyebrow');

      assert.equal(eyebrow.textContent, 'Raphael / Sync notes');
      assert.notEqual(eyebrow.getAttribute('role'), 'button');
    } finally {
      screen.unmount();
    }
  });

  it('draws Move disabled, with the reason it comes back, while it cannot be used', () => {
    for (const [state, hint] of [
      [{ locked: true }, MOVE_LOCKED_HINT],
      [{ leaving: true }, MOVE_LOCKED_HINT],
      [{ moveInflight: true }, MOVE_UNCONFIRMED_HINT],
    ]) {
      let moves = 0;
      const screen = render(
        editor({
          move: {
            ...moveControl({
              locationKnown: true,
              locked: false,
              leaving: false,
              moveInflight: false,
              ...state,
            }),
            onPress: () => {
              moves += 1;
            },
          },
        }),
      );

      try {
        const eyebrow = screen.byTestId('edit-eyebrow');

        assert.equal(eyebrow.getAttribute('aria-disabled'), 'true', hint);
        assert.equal(eyebrow.getAttribute('aria-description'), hint);
        screen.pressTestId('edit-eyebrow');
        assert.equal(moves, 0, 'a disabled Move does nothing');
      } finally {
        screen.unmount();
      }
    }
  });

  it('draws the moved status the view derives, and the ordinary one once the standing moves on', () => {
    const moved = { place: 'Raphael', revision: 8 };
    const acknowledged = render(
      editor({ view: viewFor({ kind: 'synced', revision: 8 }, { moved }) }),
    );

    try {
      assert.equal(
        acknowledged.byTestId('edit-status').textContent,
        'Moved to Raphael · revision 8',
      );
    } finally {
      acknowledged.unmount();
    }

    const later = render(editor({ view: viewFor({ kind: 'synced', revision: 9 }, { moved }) }));

    try {
      assert.equal(later.byTestId('edit-status').textContent, 'On your server · revision 9');
    } finally {
      later.unmount();
    }
  });

  it('draws no eyebrow at all when the location could not be established', () => {
    // An empty location is what an unknown parent produces, and saying nothing is the point: a
    // phone that could not read where something lives must not claim it lives anywhere.
    const screen = render(editor({ location: [] }));

    try {
      assert.equal(screen.byTestId('edit-eyebrow'), null);
      assert.ok(!screen.text().includes('/'), 'nothing that looks like a path');
    } finally {
      screen.unmount();
    }
  });

  it('draws the conflict band only when the view reports the notice, and goes quiet while it does', () => {
    const conflicted = render(editor({ view: viewFor({ kind: 'conflicted' }) }));

    try {
      assert.ok(conflicted.byTestId('edit-conflict') !== null, 'the band');
      assert.ok(conflicted.text().includes(CONFLICT_NOTICE));
      assert.equal(conflicted.byTestId('edit-discard').textContent, 'Discard');
      // The alert colour appears once. The status line still states the fact, quietly.
      assert.equal(conflicted.byTestId('edit-status').textContent, CONFLICTED_STATUS);
      assert.ok(!conflicted.byTestId('edit-status').className.includes('text-danger'));
    } finally {
      conflicted.unmount();
    }

    const ordinary = render(editor({ view: viewFor({ kind: 'pending' }) }));

    try {
      assert.equal(ordinary.byTestId('edit-conflict'), null);
      assert.equal(ordinary.byTestId('edit-discard'), null);
    } finally {
      ordinary.unmount();
    }
  });

  it('keeps the alert tone on every other standing, since nothing else on screen says it', () => {
    const screen = render(editor({ view: viewFor({ kind: 'offline' }) }));

    try {
      assert.ok(screen.byTestId('edit-status').className.includes('text-danger'));
      assert.equal(screen.byTestId('edit-conflict'), null);
    } finally {
      screen.unmount();
    }
  });

  it('disables the close control while leaving waits for the server, and says why', () => {
    const waiting = render(editor({ leaving: true }));

    try {
      const close = waiting.byLabel('Close');
      assert.equal(close.getAttribute('aria-disabled'), 'true');
      assert.ok((close.getAttribute('aria-description') ?? '').length > 0, 'it says why');
    } finally {
      waiting.unmount();
    }

    const free = render(editor());

    try {
      assert.notEqual(free.byLabel('Close').getAttribute('aria-disabled'), 'true');
    } finally {
      free.unmount();
    }
  });

  it('names the chip by what is being edited, and never says "slug"', () => {
    for (const [nodeType, kind, expected] of [
      ['resource', 'note', 'note ID'],
      ['area', null, 'area ID'],
      ['project', null, 'project ID'],
    ]) {
      const chip = detailsChip({ nodeType, kind, slug: 'a-thing', tagCount: 1 });

      assert.equal(chip.spoken, `Details: ${expected} a-thing, 1 tag`);
      assert.equal(chip.label, 'a-thing · 1 tag');
      assert.ok(!`${chip.label} ${chip.spoken} ${chip.hint}`.toLowerCase().includes('slug'));
    }

    // With no tags there is nothing to count, so the chip is the ID alone.
    assert.equal(
      detailsChip({ nodeType: 'resource', kind: 'note', slug: 'a-thing', tagCount: 0 }).label,
      'a-thing',
    );
  });
});

const sheet = (over = {}) =>
  createElement(DetailsSheet, {
    visible: true,
    sessionId: 1,
    idLabel: 'note ID',
    slug: 'autosave-loop-notes',
    tags: ['sync', 'design'],
    onDone: () => {},
    onClose: () => {},
    ...over,
  });

describe('the details sheet', () => {
  it('holds Done until something differs from what it opened with', () => {
    const screen = render(sheet());

    try {
      assert.equal(screen.byTestId('details-done').getAttribute('aria-disabled'), 'true');

      type(screen.byTestId('details-slug'), 'a-new-id');

      assert.notEqual(screen.byTestId('details-done').getAttribute('aria-disabled'), 'true');
    } finally {
      screen.unmount();
    }
  });

  it('commits the ID and the tags together, once', () => {
    const committed = [];
    const screen = render(
      sheet({
        onDone: (details) => {
          committed.push(details);
        },
      }),
    );

    try {
      type(screen.byTestId('details-slug'), '  spaced-id  ');
      type(screen.byTestId('details-tag-entry'), 'mobile');
      screen.press('Add tag');
      screen.pressTestId('details-done');

      assert.deepEqual(committed, [{ slug: 'spaced-id', tags: ['sync', 'design', 'mobile'] }]);
    } finally {
      screen.unmount();
    }
  });

  /**
   * The obligation phase 05 recorded and handed to whoever built tag entry.
   *
   * `applyTags` reproduces the server's tag rule under raw equality while the server applies it to
   * values its decoder has already trimmed and NFC-normalized. An editor holding `work` and `work `
   * therefore diffs to an addition the contract refuses as a repeat - and `writeEditVersion` resumes
   * autosave on the next keystroke, so the same envelope is sent forever. Normalizing at entry is
   * what keeps the editor's tags and the server's in one identity before `diff` ever sees them.
   */
  it('normalizes a tag on the way in, so the editor and the server share one identity', () => {
    const committed = [];
    const screen = render(
      sheet({
        tags: [],
        onDone: (details) => {
          committed.push(details);
        },
      }),
    );

    try {
      type(screen.byTestId('details-tag-entry'), 'work ');
      screen.press('Add tag');
      // The same tag again, spelled differently. Both normalize onto `work`, and the second is a
      // repeat rather than a second tag.
      type(screen.byTestId('details-tag-entry'), ' work');
      screen.press('Add tag');
      // Decomposed é, which the contract composes.
      type(screen.byTestId('details-tag-entry'), 'café');
      screen.press('Add tag');
      screen.pressTestId('details-done');

      assert.deepEqual(committed, [{ slug: 'autosave-loop-notes', tags: ['work', 'café'] }]);
    } finally {
      screen.unmount();
    }
  });

  it('forgets what was typed when it is closed any way but Done', () => {
    const committed = [];
    const closes = [];
    const screen = render(
      sheet({
        onDone: (details) => {
          committed.push(details);
        },
        onClose: () => {
          closes.push(true);
        },
      }),
    );

    try {
      type(screen.byTestId('details-slug'), 'half-typed');
      screen.press('Cancel');

      assert.deepEqual(closes, [true]);
      assert.deepEqual(committed, [], 'nothing reached the owner');
    } finally {
      screen.unmount();
    }
  });

  /**
   * The one thing that may forget what was typed is a new opening.
   *
   * `publishRecord` re-reads the row on every acknowledgement and JSON-parses a fresh `tags` array,
   * so seeding from the props' identity meant an ordinary autosave landing while the sheet was open
   * silently replaced a half-typed ID with the stored one and disabled Done - no user action, no
   * explanation. The editor lock the sheet holds gates the renderer, not the autosave tick, so this
   * is the ordinary case rather than a rare one.
   */
  it('survives a record that moves underneath it, and re-seeds only on a new opening', () => {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const root = createRoot(host);
    const field = () => host.querySelector('[data-testid="details-slug"]');
    const done = () => host.querySelector('[data-testid="details-done"]');

    try {
      act(() => {
        root.render(sheet({ tags: ['sync'] }));
      });
      type(field(), 'half-typed-id');

      // Exactly what an acknowledgement publishes: equal tags, a new array.
      act(() => {
        root.render(sheet({ tags: ['sync'] }));
      });

      assert.equal(field().value, 'half-typed-id', 'what was typed is still there');
      assert.notEqual(done().getAttribute('aria-disabled'), 'true', 'and Done is still offered');

      // A new opening is the one thing that does forget it.
      act(() => {
        root.render(sheet({ sessionId: 2, tags: ['sync'] }));
      });

      assert.equal(field().value, 'autosave-loop-notes');
      assert.equal(done().getAttribute('aria-disabled'), 'true');
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  it('shows tags only where there is no ID yet', () => {
    const screen = render(sheet({ slug: null }));

    try {
      assert.equal(screen.byTestId('details-slug'), null);
      assert.ok(screen.byTestId('details-tag-entry') !== null);
    } finally {
      screen.unmount();
    }
  });
});

describe('an entity that could not be opened', () => {
  it('says only what is true of the reason, and offers one way out', () => {
    const screen = render(
      createElement(EntityUnavailable, {
        state: { kind: 'unreadable', reason: 'missing' },
        onClose: () => {},
      }),
    );

    try {
      assert.ok(screen.text().includes('This is not here.'));
      assert.equal(screen.byTestId('entity-unavailable-discard'), null, 'nothing to discard');
    } finally {
      screen.unmount();
    }
  });

  it('offers Discard for changes it is holding and cannot read', () => {
    const discards = [];
    const screen = render(
      createElement(EntityUnavailable, {
        state: { kind: 'retained', sentence: 'They are kept exactly as they are.' },
        onClose: () => {},
        onDiscard: () => {
          discards.push(true);
        },
      }),
    );

    try {
      assert.ok(screen.text().includes('They are kept exactly as they are.'));
      screen.pressTestId('entity-unavailable-discard');
      assert.deepEqual(discards, [true]);
    } finally {
      screen.unmount();
    }
  });
});

describe('the Edit action on a container', () => {
  it('is absent until the entity has loaded', () => {
    const loading = render(createElement(ContainerEditAction, { kind: 'area', id: null }));

    try {
      assert.equal(loading.byTestId('container-edit'), null);
    } finally {
      loading.unmount();
    }

    const loaded = render(createElement(ContainerEditAction, { kind: 'area', id: 4 }));

    try {
      assert.ok(loaded.byTestId('container-edit') !== null);
      assert.ok(loaded.byLabel('Edit this area') !== null);
      assert.equal(loaded.text(), 'Edit');
    } finally {
      loaded.unmount();
    }
  });

  it('is spoken by what it edits', () => {
    const screen = render(createElement(ContainerEditAction, { kind: 'project', id: 9 }));

    try {
      assert.ok(screen.byLabel('Edit this project') !== null);
    } finally {
      screen.unmount();
    }
  });
});

describe('the location the screen reads, from the owner', () => {
  it('follows a location the owner advances later, with no prop change', async () => {
    const { useEditLocation, useEditOwner } =
      await import('../src/modules/capture/client/edit-owner.ts');
    const seen = [];
    const Probe = () => {
      const location = useEditLocation('c1/42', { kind: 'known', parentId: 3 });

      seen.push(location.kind === 'known' ? location.parentId : 'unknown');

      return null;
    };
    const screen = render(createElement(Probe));

    try {
      // Before the owner says anything, the open's answer.
      assert.equal(seen.at(-1), 3);

      // A move acknowledged by reconciliation, with no sheet on screen.
      act(() => {
        useEditOwner.setState((state) => ({
          locations: { ...state.locations, 'c1/42': { kind: 'known', parentId: 5 } },
        }));
      });
      assert.equal(seen.at(-1), 5);

      act(() => {
        useEditOwner.setState((state) => ({
          locations: { ...state.locations, 'c1/42': { kind: 'known', parentId: null } },
        }));
      });
      assert.equal(seen.at(-1), null, 'the top level is a location, not a missing one');
    } finally {
      screen.unmount();
      useEditOwner.setState({ locations: {} });
    }
  });
});
