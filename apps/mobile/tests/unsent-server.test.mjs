/**
 * The phone's unsent writing against a real server: creates, edits, lost replies, a real slug clash,
 * a real conflict, and the same-content check agreeing with how the server normalizes.
 *
 * Everything is real except `fetch`, which a case replaces only to make an answer go missing after
 * the server committed. The CLI reads back what the phone wrote, across a real process boundary.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { create, get, list, update } from '@raphael/client/nodes';
import { createEmptyDocument } from '@raphael/content';
import { canonicalizeDocument } from '@raphael/content/schema';
import { Either } from 'effect';

import { sameContent } from '../src/modules/unsent/row.ts';
import {
  cleanupDirectories,
  cliJson,
  losingNextAnswer,
  phoneTransport,
  unsentOver,
  withServer,
} from './support/cross-client.mjs';
import { createRow, editRow } from './support/unsent-rows.mjs';

after(cleanupDirectories);

/** The seeded area every case files under. */
const WORK = { id: 1, path: '/work' };

const paragraphs = (...texts) => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

/** What the editor's WebView does to every snapshot before the phone stores it. */
const canonical = (document) => {
  const result = canonicalizeDocument(document);

  assert.ok(Either.isRight(result), 'a document the editor could hold');

  return result.right;
};

const insert = (phone, row) => phone.store.change({ id: row.id }, () => row);

const unwrapped = async (promise) => {
  const result = await promise;

  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.failure));

  return result.value;
};

/** Every note directly in `/work`, by slug. */
const notesInWork = async (transport) => {
  const page = await unwrapped(
    list(transport, { scopes: [{ id: WORK.id }], limit: 500, includeArchived: true }),
  );

  return page.items.filter((item) => item.type === 'resource').map((item) => item.slug);
};

const pendingCreate = (over = {}) =>
  createRow({
    status: 'pending',
    destination: { type: 'area', id: WORK.id },
    title: 'Field notes',
    slug: 'field-notes',
    body: canonical(paragraphs('Written on the phone')),
    ...over,
  });

/** A note the other client made, and an edit row the phone would start from it. */
const serverNote = async (transport, title = 'Shared note') =>
  (
    await unwrapped(
      create(transport, {
        type: 'resource',
        kind: 'note',
        parent: { id: WORK.id },
        title,
        slug: title.toLowerCase().replaceAll(' ', '-'),
        body: { format: 'tiptap', value: paragraphs('From elsewhere') },
        format: 'tiptap',
      }),
    )
  ).entity;

const editOf = (entity, over = {}) =>
  editRow(entity.id, {
    nodeType: entity.type,
    kind: entity.kind,
    baseRevision: entity.revision,
    title: entity.title,
    description: entity.description,
    slug: entity.slug,
    tags: entity.tags,
    body: entity.body.value,
    version: 1,
    sentVersion: 0,
    ...over,
  });

describe('a note the phone creates', () => {
  it('reaches the server once, and the terminal reads what the phone wrote', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint);

      try {
        await insert(
          phone,
          pendingCreate({ tags: ['field', 'sync'], description: 'Notes from a walk' }),
        );
        assert.equal(await phone.send(), 'settled');
        assert.equal(phone.store.rows().length, 0, 'gone once the server has it');

        const { entity: read } = await cliJson(['get', '/work/field-notes'], { endpoint });

        assert.equal(read.title, 'Field notes');
        assert.equal(read.description, 'Notes from a walk');
        assert.deepEqual(read.tags, ['field', 'sync']);
        assert.equal(read.kind, 'note');
      } finally {
        await phone.close();
      }
    });
  });

  it('adopts its own creation when the reply was lost, without a duplicate', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint, {
        fetch: losingNextAnswer((url) => url.endsWith('/api/nodes/create')),
      });

      try {
        await insert(phone, pendingCreate());
        assert.equal(
          await phone.send(),
          'backed_off',
          'the lost reply looks like a network failure',
        );
        assert.ok(phone.row('draft-1').error !== null, 'waiting to sync');

        assert.equal(await phone.send(), 'settled');
        assert.equal(phone.store.rows().length, 0);
        assert.deepEqual(
          (await notesInWork(phone.transport)).filter((slug) => slug.startsWith('field-notes')),
          ['field-notes'],
          'one note, not two',
        );
      } finally {
        await phone.close();
      }
    });
  });

  it('takes the next free slug when something else already has its address', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint);

      try {
        await serverNote(phone.transport, 'Field notes');
        await insert(phone, pendingCreate());
        assert.equal(await phone.send(), 'settled');

        const slugs = await notesInWork(phone.transport);

        assert.ok(slugs.includes('field-notes'));
        assert.ok(slugs.includes('field-notes-2'), 'the phone’s note, suffixed');
      } finally {
        await phone.close();
      }
    });
  });

  it('is refused with the server’s own words when its parent is gone', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint);

      try {
        await insert(phone, pendingCreate({ destination: { type: 'area', id: 999 } }));
        assert.equal(await phone.send(), 'settled');

        const row = phone.row('draft-1');

        assert.equal(row.status, 'refused');
        assert.ok(row.error.length > 0);
      } finally {
        await phone.close();
      }
    });
  });
});

describe('a note the phone edits', () => {
  it('saves the edit, caches the answer, and is gone', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint);

      try {
        const note = await serverNote(phone.transport);

        await insert(phone, editOf(note, { title: 'Edited on the phone' }));
        assert.equal(await phone.send(), 'settled');

        const read = await unwrapped(get(phone.transport, { target: { id: note.id } }));

        assert.equal(read.entity.title, 'Edited on the phone');
        assert.equal(read.entity.revision, note.revision + 1);
        assert.equal(phone.cached.get(note.id).revision, note.revision + 1);
        assert.equal(phone.store.rows().length, 0);
      } finally {
        await phone.close();
      }
    });
  });

  it('settles quietly when the reply to an edit was lost', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint, {
        fetch: losingNextAnswer((url) => url.endsWith('/api/nodes/update')),
      });

      try {
        const note = await serverNote(phone.transport);

        await insert(phone, editOf(note, { title: 'Edited on the phone' }));
        assert.equal(await phone.send(), 'backed_off');
        // The retry meets its own first attempt as a revision conflict, and recognises it.
        assert.equal(await phone.send(), 'settled');
        assert.equal(phone.store.rows().length, 0, 'no conflict for a reply that was only lost');

        const read = await unwrapped(get(phone.transport, { target: { id: note.id } }));

        assert.equal(read.entity.revision, note.revision + 1, 'applied once');
      } finally {
        await phone.close();
      }
    });
  });

  it('is a conflict when another client changed it, resolved by taking the server’s or keeping mine', async () => {
    await withServer(async ({ endpoint }) => {
      const phone = await unsentOver(endpoint);
      const other = phoneTransport(endpoint);

      try {
        const note = await serverNote(phone.transport);

        await unwrapped(
          update(other, { target: { id: note.id }, revision: note.revision, title: 'Theirs' }),
        );
        await insert(phone, editOf(note, { title: 'Mine' }));
        assert.equal(await phone.send(), 'settled');
        assert.equal(phone.row(`edit-${String(note.id)}`).status, 'conflict');

        // Keep mine: send again at whatever revision the server holds now.
        const current = await unwrapped(get(other, { target: { id: note.id }, format: 'tiptap' }));

        await phone.store.change({ id: `edit-${String(note.id)}` }, (row) => ({
          ...row,
          baseRevision: current.entity.revision,
          status: 'pending',
        }));
        assert.equal(await phone.send(), 'settled');

        const kept = await unwrapped(get(other, { target: { id: note.id }, format: 'tiptap' }));

        assert.equal(kept.entity.title, 'Mine');

        // Take the server's: the row goes and nothing is sent.
        await unwrapped(
          update(other, {
            target: { id: note.id },
            revision: kept.entity.revision,
            title: 'Theirs again',
          }),
        );
        await insert(phone, editOf(kept.entity, { id: 'second', title: 'Mine again' }));
        await phone.send();
        assert.equal(phone.row('second').status, 'conflict');
        await phone.store.change({ id: 'second' }, () => null);

        const taken = await unwrapped(get(other, { target: { id: note.id }, format: 'tiptap' }));

        assert.equal(taken.entity.title, 'Theirs again');
      } finally {
        await phone.close();
      }
    });
  });
});

describe('the same-content check against the server', () => {
  const messy = {
    title: '  Field notes \t',
    tags: [' walk ', 'été'],
    description: 'Notes from a walk',
    // Whitespace inside bold, which canonicalization moves outside the mark.
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'then plain' },
          ],
        },
      ],
    },
  };

  it('recognises the server’s echo of a create as the same writing', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const row = createRow({
        destination: { type: 'area', id: WORK.id },
        title: messy.title,
        slug: 'field-notes',
        tags: messy.tags,
        description: messy.description,
        body: canonical(messy.body),
      });
      const created = await unwrapped(
        create(transport, {
          type: 'resource',
          kind: 'note',
          parent: { id: WORK.id },
          title: row.title,
          slug: row.slug,
          description: row.description,
          tags: [...row.tags],
          body: { format: 'tiptap', value: row.body },
          format: 'tiptap',
        }),
      );

      assert.ok(sameContent(row, created.entity));
      assert.ok(!sameContent({ ...row, title: 'Something else' }, created.entity));
    });
  });

  it('recognises the server’s echo of an update as the same writing', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const note = await serverNote(transport);
      const row = editOf(note, {
        title: messy.title,
        tags: messy.tags,
        description: messy.description,
        body: canonical(messy.body),
      });
      const updated = await unwrapped(
        update(transport, {
          target: { id: note.id },
          revision: note.revision,
          title: row.title,
          description: row.description,
          slug: row.slug,
          tags: [...row.tags],
          body: { format: 'tiptap', value: row.body },
          format: 'tiptap',
        }),
      );

      assert.ok(sameContent(row, updated.entity));
    });
  });

  it('holds for the empty document a new note starts with', async () => {
    await withServer(async ({ endpoint }) => {
      const transport = phoneTransport(endpoint);
      const row = createRow({
        destination: { type: 'area', id: WORK.id },
        title: 'Empty',
        slug: 'empty',
        body: createEmptyDocument(),
      });
      const created = await unwrapped(
        create(transport, {
          type: 'resource',
          kind: 'note',
          parent: { id: WORK.id },
          title: row.title,
          slug: row.slug,
          body: { format: 'tiptap', value: row.body },
          format: 'tiptap',
        }),
      );

      assert.ok(sameContent(row, created.entity));
    });
  });
});
