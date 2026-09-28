/**
 * The transition table, row by row, plus the slug helpers the create rows depend on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyDocument } from '@raphael/content';

import {
  MAX_SUFFIX_TRIES,
  nextSlug,
  sameContent,
  sameWriting,
  slugFor,
  titleFor,
  withSuffix,
} from './row.ts';
import { needsLookup, transition } from './transition.ts';

const body = createEmptyDocument();

const createRow = (over = {}) => ({
  id: 'r1',
  op: 'create',
  nodeType: 'resource',
  kind: 'note',
  nodeId: null,
  baseRevision: null,
  destination: { type: 'area', id: 1 },
  title: 'Field notes',
  description: '',
  slug: 'field-notes',
  tags: [],
  body,
  status: 'pending',
  error: null,
  version: 3,
  sentVersion: 0,
  updatedAt: 1,
  ...over,
});

const editRow = (over = {}) =>
  createRow({
    op: 'edit',
    nodeId: 42,
    baseRevision: 7,
    destination: null,
    version: 5,
    sentVersion: 2,
    ...over,
  });

const entity = (over = {}) => ({
  id: 42,
  type: 'resource',
  kind: 'note',
  parentId: 1,
  slug: 'field-notes',
  revision: 8,
  title: 'Field notes',
  description: '',
  tags: [],
  active: false,
  archived: false,
  isFavorite: false,
  archiveCauses: [],
  body: { format: 'tiptap', value: createEmptyDocument() },
  metadata: {},
  ...over,
});

const failed = (failure) => ({ kind: 'failed', failure });
const network = { kind: 'network', message: 'The server could not be reached.' };
const conflict = (code) => ({ kind: 'http', status: 409, code, message: `${code} message` });

describe('a create', () => {
  it('is deleted, and its entity cached, when the server creates it', () => {
    const row = createRow();
    const step = transition(row, row, { kind: 'saved', entity: entity() });

    assert.equal(step.row, null);
    assert.equal(step.entity.id, 42);
    assert.equal(step.outcome, 'saved');
  });

  it('becomes an edit of what it created when typing landed while it was out', () => {
    const sent = createRow({ version: 3 });
    const step = transition(createRow({ version: 4 }), sent, { kind: 'saved', entity: entity() });

    assert.equal(step.row.op, 'edit');
    assert.equal(step.row.nodeId, 42);
    assert.equal(step.row.baseRevision, 8);
    assert.equal(step.row.sentVersion, 3);
    assert.equal(step.row.status, 'pending');
    assert.equal(step.outcome, 'saved');
  });

  it('stays pending with the failure’s message after a retryable failure', () => {
    const row = createRow();

    for (const failure of [
      network,
      { kind: 'timeout', message: 'slow' },
      { kind: 'http', status: 503, message: 'down' },
    ]) {
      const step = transition(row, row, failed(failure));

      assert.equal(step.row.status, 'pending');
      assert.equal(step.row.error, failure.message);
      assert.equal(step.outcome, 'waiting');
    }
  });

  it('looks up a slug clash, and only a slug clash', () => {
    const row = createRow();

    assert.equal(needsLookup(row, conflict('slug_conflict')), true);
    assert.equal(needsLookup(row, conflict('revision_conflict')), false);
    assert.equal(needsLookup(row, network), false);
  });

  it('adopts what it finds when the clash is its own lost reply', () => {
    const row = createRow({ title: '  Field notes ' });
    const step = transition(row, row, { kind: 'found', entity: entity() });

    assert.equal(step.row, null);
    assert.equal(step.outcome, 'saved');
  });

  it('suffixes and goes again when the clash is something else', () => {
    const row = createRow();
    const step = transition(row, row, { kind: 'found', entity: entity({ title: 'Other' }) });

    assert.equal(step.row.slug, 'field-notes-2');
    assert.equal(step.row.status, 'pending');
    assert.equal(step.outcome, null, 'sent again at once');

    const again = transition(step.row, step.row, {
      kind: 'found',
      entity: entity({ title: 'Other' }),
    });

    assert.equal(again.row.slug, 'field-notes-3');
  });

  it('is refused once the suffixes run out', () => {
    const row = createRow({ slug: withSuffix('field-notes', MAX_SUFFIX_TRIES + 1) });
    const step = transition(row, row, { kind: 'found', entity: entity({ title: 'Other' }) });

    assert.equal(step.row.status, 'refused');
    assert.equal(step.outcome, 'refused');
  });

  it('is refused with the server’s message for any other refusal', () => {
    const row = createRow();
    const refusal = {
      kind: 'http',
      status: 409,
      code: 'node_archived',
      message: 'The parent is inside something archived.',
    };
    const step = transition(row, row, failed(refusal));

    assert.equal(step.row.status, 'refused');
    assert.equal(step.row.error, refusal.message);
    assert.equal(step.outcome, 'refused');
  });
});

describe('an edit', () => {
  it('is deleted when the server has everything written', () => {
    const row = editRow({ version: 5 });
    const step = transition(row, row, { kind: 'saved', entity: entity() });

    assert.equal(step.row, null);
    assert.equal(step.outcome, 'saved');
  });

  it('moves its base on and stays pending when typing landed while it was out', () => {
    const sent = editRow({ version: 5 });
    const step = transition(editRow({ version: 6 }), sent, { kind: 'saved', entity: entity() });

    assert.equal(step.row.baseRevision, 8);
    assert.equal(step.row.sentVersion, 5);
    assert.equal(step.row.status, 'pending');
  });

  it('never moves sentVersion backwards', () => {
    const sent = editRow({ version: 3 });
    const step = transition(editRow({ version: 6, sentVersion: 4 }), sent, {
      kind: 'saved',
      entity: entity(),
    });

    assert.equal(step.row.sentVersion, 4);
  });

  it('looks up a revision clash, and only a revision clash', () => {
    const row = editRow();

    assert.equal(needsLookup(row, conflict('revision_conflict')), true);
    assert.equal(needsLookup(row, conflict('slug_conflict')), false);
  });

  it('adopts the server’s revision when the clash is its own lost reply', () => {
    const row = editRow({ version: 5 });
    const step = transition(row, row, { kind: 'found', entity: entity({ revision: 9 }) });

    assert.equal(step.row, null);
    assert.equal(step.entity.revision, 9);
  });

  it('is a conflict when the server holds something else', () => {
    const row = editRow();
    const step = transition(row, row, { kind: 'found', entity: entity({ title: 'Theirs' }) });

    assert.equal(step.row.status, 'conflict');
    assert.equal(step.outcome, 'conflict');
  });

  it('stays pending after a retryable failure, and is refused after any other', () => {
    const row = editRow();

    assert.equal(transition(row, row, failed(network)).row.status, 'pending');
    assert.equal(transition(row, row, failed(conflict('slug_conflict'))).row.status, 'refused');
  });
});

describe('the same-content check', () => {
  it('normalizes the way the server does', () => {
    const row = editRow({ title: ' Field notes  ', tags: [' work', 'e\u0301te\u0301'] });

    assert.equal(sameContent(row, entity({ tags: ['work', '\u00e9t\u00e9'] })), true);
    assert.equal(sameContent(row, entity({ tags: ['work'] })), false);
  });

  it('compares the parent for a create, not for an edit', () => {
    const row = createRow({ destination: { root: true } });

    assert.equal(sameContent(row, entity({ parentId: null })), true);
    assert.equal(sameContent(row, entity({ parentId: 1 })), false);
    assert.equal(sameContent(editRow(), entity({ parentId: 99 })), true);
  });

  it('compares the body structurally', () => {
    const written = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
    };

    assert.equal(
      sameContent(
        editRow({ body: written }),
        entity({ body: { format: 'tiptap', value: structuredClone(written) } }),
      ),
      true,
    );
    assert.equal(sameContent(editRow({ body: written }), entity()), false);
  });
});

describe('a write that changes nothing', () => {
  it('is told apart from one that does, field for field', () => {
    const row = editRow({ tags: ['a'] });

    assert.equal(sameWriting({ ...row, tags: ['a'], body: structuredClone(row.body) }, row), true);
    assert.equal(sameWriting({ ...row, title: 'Field notes ' }, row), false, 'raw, not normalized');
    assert.equal(sameWriting({ ...row, tags: ['a', 'b'] }, row), false);
  });
});

describe('titles and slugs for a new item', () => {
  it('takes the typed title, or else the first line of writing', () => {
    assert.equal(titleFor(createRow({ title: '  Typed ' })), 'Typed');
    assert.equal(
      titleFor(createRow({ title: '', description: 'From the description' })),
      'From the description',
    );
    assert.equal(titleFor(createRow({ title: '', description: '' })), null);
  });

  it('derives a slug, cutting whole words to fit the bound', () => {
    assert.equal(slugFor('Field Notes!'), 'field-notes');
    assert.equal(slugFor('!!!'), null);

    const long = slugFor(`${'word '.repeat(40)}end`);

    assert.ok(long !== null && [...long].length <= 100);
    assert.ok(long.endsWith('word'), 'cut on a word, not inside one');
  });

  it('suffixes within the bound', () => {
    const base = 'a'.repeat(100);

    assert.ok([...withSuffix(base, 2)].length <= 100);
    assert.equal(nextSlug('notes', 'notes'), 'notes-2');
    assert.equal(nextSlug('notes', 'notes-2'), 'notes-3');
  });
});
