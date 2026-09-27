/**
 * The shared flat-list row, its mark, and the favorite star's busy state, rendered.
 *
 * `ListRow` is the row every flat list draws, so what it says aloud is pinned here once rather than
 * on each screen: the title, the kind, any state, and the container, in that order, from a press
 * surface that speaks for everything inside it. The mark and the state pill are silent on purpose,
 * and the trailing slot is its own touch target, outside the row's press surface.
 *
 * The reanimated stub reports reduced motion as on, so a row renders with no entering, exiting or
 * layout animation at all - which is the reduced-motion promise, observed.
 */

import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { installDom } from './support/browser-dom.mjs';
import { installNativeStubs } from './support/native-stub-loader.mjs';

const hooks = installNativeStubs();
const dom = installDom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Archive } = await import('lucide-react-native');
const { FavoriteButton, ListRow, ShapeMark } = await import('../src/ui/index.ts');

after(() => {
  dom.teardown();
  hooks.deregister();
});

const mounted = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

/** Renders one element and returns a small query surface over it. */
const render = (element) => {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(element);
  });

  const unmount = () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  mounted.push(unmount);

  return {
    host,
    $: (selector) => host.querySelector(selector),
    $$: (selector) => [...host.querySelectorAll(selector)],
    text: () => host.textContent ?? '',
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
  };
};

const row = (over = {}) =>
  createElement(ListRow, {
    mark: { kind: 'project', id: 12 },
    title: 'Auth rework',
    kindLabel: 'Project',
    onPress: () => undefined,
    testID: 'row',
    ...over,
  });

const pressSurface = (view) => view.$('[data-testid="row"] [role="button"]');

describe('a list row', () => {
  it('shows the title and the kind word', () => {
    const view = render(row());

    assert.ok(view.text().includes('Auth rework'));
    assert.ok(view.text().includes('Project'));
  });

  it('speaks the title and kind, then any state, then the container', () => {
    const archived = { icon: Archive, label: 'Archived' };
    const work = { kind: 'area', id: 1, title: 'Work' };

    assert.equal(pressSurface(render(row())).getAttribute('aria-label'), 'Auth rework, Project');
    assert.equal(
      pressSurface(render(row({ status: archived }))).getAttribute('aria-label'),
      'Auth rework, Project, archived',
    );
    assert.equal(
      pressSurface(render(row({ parent: work }))).getAttribute('aria-label'),
      'Auth rework, Project, in Work',
    );
    assert.equal(
      pressSurface(render(row({ status: archived, parent: work }))).getAttribute('aria-label'),
      'Auth rework, Project, archived, in Work',
    );
  });

  it('draws the state pill, then the parent pill, only when given', () => {
    const bare = render(row());

    assert.equal(bare.$$('[data-icon="Archive"]').length, 0);
    assert.ok(!bare.text().includes('Work'));

    const full = render(
      row({
        status: { icon: Archive, label: 'Archived' },
        parent: { kind: 'area', id: 1, title: 'Work' },
      }),
    );
    const secondLine = full.text();

    assert.equal(full.$$('[data-icon="Archive"]').length, 1);
    assert.ok(
      secondLine.indexOf('Project') < secondLine.indexOf('Archived') &&
        secondLine.indexOf('Archived') < secondLine.indexOf('Work'),
      'kind word, then state, then container',
    );
  });

  it("draws the parent's own mark in its pill", () => {
    const inArea = render(row({ parent: { kind: 'area', id: 1, title: 'Work' } }));
    const inProject = render(
      row({ mark: { kind: 'note', id: 41 }, parent: { kind: 'project', id: 12, title: 'Auth' } }),
    );

    // The area's `Layers`, outside the row's own mark.
    assert.equal(
      inArea
        .$$('[data-icon="Layers"]')
        .filter((icon) => icon.closest('[data-testid="shape-mark"]') === null).length,
      1,
    );
    assert.equal(
      inProject.$$('[data-icon="Layers"]').length,
      0,
      "a project's pill carries its emblem, not the area mark",
    );
  });

  it('calls back when pressed, and carries the hint it is given', () => {
    let pressed = 0;
    const view = render(
      row({
        accessibilityHint: 'Opens this project',
        onPress: () => {
          pressed += 1;
        },
      }),
    );

    act(() => {
      pressSurface(view).click();
    });

    assert.equal(pressed, 1);
    assert.equal(pressSurface(view).getAttribute('aria-description'), 'Opens this project');
  });

  it('puts the trailing control outside the press surface, as its own target', () => {
    let rowPressed = 0;
    let trailingPressed = 0;
    const view = render(
      row({
        onPress: () => {
          rowPressed += 1;
        },
        trailing: createElement(FavoriteButton, {
          favorited: true,
          label: 'Auth rework',
          onToggle: () => {
            trailingPressed += 1;
          },
          testID: 'star',
        }),
      }),
    );
    const star = view.$('[data-testid="star"]');

    assert.ok(star !== null);
    assert.equal(pressSurface(view).contains(star), false);

    act(() => {
      star.click();
    });

    assert.equal(trailingPressed, 1);
    assert.equal(rowPressed, 0);
  });

  it('shows a failure line under the row, announced politely, only when given', () => {
    assert.equal(render(row()).$$('[aria-live="polite"]').length, 0);

    const view = render(row({ failure: 'Favorite did not update. Try again.' }));
    const line = view.$('[aria-live="polite"]');

    assert.equal(line?.textContent, 'Favorite did not update. Try again.');
    assert.equal(pressSurface(view).contains(line), false);
  });

  it('carries no animation under reduced motion', () => {
    const view = render(row());
    const animated = view.$('[data-testid="row"]');

    assert.ok(animated.hasAttribute('data-animated'));
    for (const prop of ['entering', 'exiting', 'layout']) {
      assert.ok(!animated.hasAttribute(prop), `no ${prop} animation`);
    }
  });
});

describe('a shape mark', () => {
  it('is silent: no label, and hidden from the screen reader', () => {
    for (const kind of ['area', 'project', 'note']) {
      const view = render(createElement(ShapeMark, { kind, id: 7 }));
      const mark = view.$('[data-testid="shape-mark"]');

      assert.ok(mark !== null);
      assert.equal(mark.getAttribute('aria-label'), null);
      assert.equal(view.$$('[aria-label]').length, 0);
    }
  });

  it('draws each kind on its own shape with its own icon', () => {
    const area = render(createElement(ShapeMark, { kind: 'area', id: 1 }));
    const project = render(createElement(ShapeMark, { kind: 'project', id: 12 }));
    const note = render(createElement(ShapeMark, { kind: 'note', id: 41 }));

    assert.equal(area.$$('[data-svg="path"]').length, 1);
    assert.equal(area.$$('[data-icon="Layers"]').length, 1);
    assert.equal(project.$$('[data-svg="path"]').length, 1);
    assert.equal(project.$$('[data-icon="Layers"]').length, 0);
    // A note sits on a soft square, drawn as a bordered view rather than a path.
    assert.equal(note.$$('[data-svg="path"]').length, 0);
    assert.equal(note.$$('[data-icon="FileText"]').length, 1);
  });
});

describe('a busy favorite star', () => {
  /** The ring is the one arc drawn with a dash; the mark's own circles are filled, not stroked. */
  const rings = (view) => view.$$('[data-svg="circle"][stroke-dasharray]').length;
  const star = (busy, onToggle) =>
    createElement(FavoriteButton, {
      favorited: false,
      label: 'Auth rework',
      onToggle,
      busy,
      testID: 'star',
    });

  it('draws the ring, is disabled and announced busy, and ignores a press', () => {
    let toggled = 0;
    const view = render(
      star(true, () => {
        toggled += 1;
      }),
    );
    const button = view.$('[data-testid="star"]');

    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('aria-selected'), 'false');
    assert.equal(rings(view), 1, 'the busy ring');

    act(() => {
      button.click();
    });
    assert.equal(toggled, 0);
  });

  it('drops the ring and takes presses again once busy clears', () => {
    let toggled = 0;
    const onToggle = () => {
      toggled += 1;
    };
    const view = render(star(true, onToggle));

    view.rerender(star(false, onToggle));
    const button = view.$('[data-testid="star"]');

    assert.equal(button.getAttribute('aria-busy'), 'false');
    assert.equal(button.getAttribute('aria-disabled'), null);
    assert.equal(rings(view), 0);

    act(() => {
      button.click();
    });
    assert.equal(toggled, 1);
  });
});
