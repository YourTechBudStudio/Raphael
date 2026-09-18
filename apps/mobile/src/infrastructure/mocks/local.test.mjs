/**
 * Session-only content, and the one property that matters about it: it never crosses connections.
 *
 * The setup here is the case that would be silently wrong without scoping. Two servers, each with a
 * container numbered 3, and a voice note captured against each. A flat store keyed by container id
 * would show one server's media under the other server's area, and nothing on screen would say so.
 *
 * Active projects used to be held here too. They are the server's now, so what is left is media and
 * favorites - and the per-connection isolation still has to hold for them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { localContent } from './local.ts';

const AREA_3 = { type: 'area', id: 3 };
const PROJECT_3 = { type: 'project', id: 3 };

const capture = (connectionId, parent, title) =>
  localContent.createVoiceNote(connectionId, parent, title, 12, [0.2, 0.5, 0.8]);

describe('two servers that both have a container 3', () => {
  it('keep their media and stars apart', async () => {
    await capture('server-a', AREA_3, 'From A');
    await capture('server-b', AREA_3, 'From B');
    await localContent.toggleFavorite('server-a', AREA_3);

    assert.deepEqual(
      (await localContent.getResources('server-a')).map((item) => item.title),
      ['From A'],
    );
    assert.deepEqual(
      (await localContent.getResources('server-b')).map((item) => item.title),
      ['From B'],
    );
    assert.deepEqual(await localContent.getFavorites('server-a'), [AREA_3]);
    assert.deepEqual(await localContent.getFavorites('server-b'), []);
  });

  it('forgetting one leaves the other untouched', async () => {
    localContent.forget('server-a');

    assert.deepEqual(await localContent.getResources('server-a'), []);
    assert.deepEqual(await localContent.getFavorites('server-a'), []);
    assert.deepEqual(
      (await localContent.getResources('server-b')).map((item) => item.title),
      ['From B'],
    );
  });
});

describe('what a local record holds', () => {
  it('is a reference and nothing copied from the server', async () => {
    const item = await capture('refs', AREA_3, 'Title');

    assert.deepEqual(item.parent, AREA_3);
    // No title, slug, or parent chain of the container is copied: a rename on the server would
    // make any of those quietly wrong, and there would be no way to notice.
    assert.deepEqual(Object.keys(item.parent).sort(), ['id', 'type']);
  });

  it('tells an area from a project with the same id', async () => {
    await capture('kinds', AREA_3, 'In the area');
    await capture('kinds', PROJECT_3, 'In the project');
    const items = await localContent.getResources('kinds');

    assert.deepEqual(
      items.filter((item) => item.parent.type === 'area').map((item) => item.title),
      ['In the area'],
    );
  });

  it('holds only kinds with no server operation, never a note', async () => {
    await capture('kinds-only', AREA_3, 'Recorded');
    const items = await localContent.getResources('kinds-only');

    // A note reaching this store again would be a second, invisible copy of something the server
    // owns - which is the whole reason the note branch was removed rather than left unused.
    assert.ok(items.every((item) => item.kind !== 'note'));
    assert.equal(localContent.createNote, undefined);
  });

  it('holds no active-project selection, which the server owns now', () => {
    // Removed rather than left unused. A project's active status is a field on its own row, read
    // and written through `nodes.update`; a second copy here would be a selection that disagreed
    // with every other client and died with the process, which is what this change ended.
    assert.equal(localContent.getActiveProjects, undefined);
    assert.equal(localContent.setProjectActive, undefined);
  });

  it('starts empty, with nothing seeded against ids nobody chose', async () => {
    assert.deepEqual(await localContent.getResources('fresh'), []);
    assert.deepEqual(await localContent.getFavorites('fresh'), []);
  });
});

describe('the selections themselves', () => {
  it('stars and unstars idempotently', async () => {
    assert.deepEqual(await localContent.toggleFavorite('sel', AREA_3), [AREA_3]);
    assert.deepEqual(await localContent.toggleFavorite('sel', AREA_3), []);
  });
});
