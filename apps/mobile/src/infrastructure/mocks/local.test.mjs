/**
 * Session-only content, and the one property that matters about it: it never crosses connections.
 *
 * The setup here is the case that would be silently wrong without scoping. Two servers, each with a
 * container numbered 3, and a note captured against each. A flat store keyed by container id would
 * show one server's note under the other server's area, and nothing on screen would say so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { localContent } from './local.ts';

const AREA_3 = { type: 'area', id: 3 };
const PROJECT_3 = { type: 'project', id: 3 };

describe('two servers that both have a container 3', () => {
  it('keep their notes, stars, and active projects apart', async () => {
    await localContent.createNote('server-a', AREA_3, 'From A', 'body');
    await localContent.createNote('server-b', AREA_3, 'From B', 'body');
    await localContent.toggleFavorite('server-a', AREA_3);
    await localContent.setProjectActive('server-b', 3, true);

    assert.deepEqual(
      (await localContent.getResources('server-a')).map((note) => note.title),
      ['From A'],
    );
    assert.deepEqual(
      (await localContent.getResources('server-b')).map((note) => note.title),
      ['From B'],
    );
    assert.deepEqual(await localContent.getFavorites('server-a'), [AREA_3]);
    assert.deepEqual(await localContent.getFavorites('server-b'), []);
    assert.deepEqual(await localContent.getActiveProjects('server-a'), []);
    assert.deepEqual(await localContent.getActiveProjects('server-b'), [3]);
  });

  it('forgetting one leaves the other untouched', async () => {
    localContent.forget('server-a');

    assert.deepEqual(await localContent.getResources('server-a'), []);
    assert.deepEqual(await localContent.getFavorites('server-a'), []);
    assert.deepEqual(
      (await localContent.getResources('server-b')).map((note) => note.title),
      ['From B'],
    );
  });
});

describe('what a local record holds', () => {
  it('is a reference and nothing copied from the server', async () => {
    const note = await localContent.createNote('refs', AREA_3, 'Title', 'Body');

    assert.deepEqual(note.parent, AREA_3);
    // No title, slug, or parent chain of the container is copied: a rename on the server would
    // make any of those quietly wrong, and there would be no way to notice.
    assert.deepEqual(Object.keys(note.parent).sort(), ['id', 'type']);
  });

  it('tells an area from a project with the same id', async () => {
    await localContent.createNote('kinds', AREA_3, 'In the area', '');
    await localContent.createNote('kinds', PROJECT_3, 'In the project', '');
    const notes = await localContent.getResources('kinds');

    assert.deepEqual(
      notes.filter((note) => note.parent.type === 'area').map((note) => note.title),
      ['In the area'],
    );
  });

  it('starts empty, with nothing seeded against ids nobody chose', async () => {
    assert.deepEqual(await localContent.getResources('fresh'), []);
    assert.deepEqual(await localContent.getFavorites('fresh'), []);
    assert.deepEqual(await localContent.getActiveProjects('fresh'), []);
  });
});

describe('the selections themselves', () => {
  it('star and unstar, and activate and deactivate, idempotently', async () => {
    assert.deepEqual(await localContent.toggleFavorite('sel', AREA_3), [AREA_3]);
    assert.deepEqual(await localContent.toggleFavorite('sel', AREA_3), []);

    await localContent.setProjectActive('sel', 9, true);
    await localContent.setProjectActive('sel', 9, true);
    assert.deepEqual(await localContent.getActiveProjects('sel'), [9]);

    await localContent.setProjectActive('sel', 9, false);
    assert.deepEqual(await localContent.getActiveProjects('sel'), []);
  });
});
