/**
 * What Recovery lists.
 *
 * Two properties decide whether unsent work can go missing. **A row this build cannot open is always
 * listed**, with Discard as its only action, because "there is nothing unfinished" and "Raphael cannot
 * read its record of unfinished work" are different sentences. And **the order is total**, so two
 * renders of the same rows never disagree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unfinishedEdits } from '../src/modules/capture/edit-unfinished.ts';

const record = (nodeId, over = {}) => ({
  key: { connectionId: 'c1', nodeId },
  endpoint: 'https://raphael.example',
  nodeType: 'resource',
  kind: 'note',
  base: { title: '', description: '', slug: '', tags: [], document: {} },
  baseRevision: 1,
  content: { title: `note ${nodeId}`, description: '', slug: 's', tags: [], document: {} },
  contentSchemaVersion: 1,
  draftVersion: 1,
  acknowledgedVersion: 1,
  inflightVersion: null,
  inflight: null,
  syncState: 'syncing',
  lastRefusal: null,
  createdAt: 0,
  updatedAt: 100,
  ...over,
});

const listed = (edits, standings, over = {}) =>
  unfinishedEdits({
    edits,
    unusableEdits: [],
    standingFor: (editKey) => standings[editKey] ?? null,
    connectionId: 'c1',
    ...over,
  });

describe('unfinishedEdits', () => {
  it('lists a record with unsent writing', () => {
    const rows = listed([record(7)], { 'c1/7': { kind: 'pending' } });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      key: 'edit:c1/7',
      editKey: 'c1/7',
      nodeId: 7,
      nodeType: 'resource',
      title: 'note 7',
      standing: 'pending',
      endpoint: 'https://raphael.example',
      scope: 'current',
      activityAt: 100,
      actions: ['open', 'discard'],
    });
  });

  it('omits a synced record, which is everything the server has', () => {
    assert.deepEqual(listed([record(7)], { 'c1/7': { kind: 'synced', revision: 4 } }), []);
  });

  it('omits a record the owner is not holding', () => {
    assert.deepEqual(listed([record(7)], {}), []);
  });

  it('files a record from another connection as retired, and still lists it', () => {
    const rows = listed([record(7, { key: { connectionId: 'other', nodeId: 7 } })], {
      'other/7': { kind: 'pending' },
    });

    assert.equal(rows[0].scope, 'retired');
  });

  it('orders by how pressing the standing is, then by latest activity, then by key', () => {
    const edits = [
      record(1, { updatedAt: 10 }),
      record(2, { updatedAt: 20 }),
      record(3, { updatedAt: 30 }),
      record(4, { updatedAt: 40 }),
      record(5, { updatedAt: 50 }),
      record(6, { updatedAt: 60 }),
    ];
    const rows = listed(edits, {
      'c1/1': { kind: 'saving' },
      'c1/2': { kind: 'pending' },
      'c1/3': { kind: 'offline' },
      'c1/4': { kind: 'unconfirmed' },
      'c1/5': { kind: 'refused', refusal: null },
      'c1/6': { kind: 'conflicted' },
    });

    assert.deepEqual(
      rows.map((row) => row.standing),
      ['conflicted', 'refused', 'unconfirmed', 'offline', 'pending', 'saving'],
    );
  });

  it('puts the latest activity first within one standing, and breaks ties by key', () => {
    const rows = listed(
      [record(1, { updatedAt: 10 }), record(2, { updatedAt: 90 }), record(3, { updatedAt: 90 })],
      {
        'c1/1': { kind: 'pending' },
        'c1/2': { kind: 'pending' },
        'c1/3': { kind: 'pending' },
      },
    );

    assert.deepEqual(
      rows.map((row) => row.nodeId),
      [2, 3, 1],
    );
  });

  it('always lists an unusable row, ahead of everything, with discard as its only action', () => {
    const rows = listed(
      [record(7, { updatedAt: 900 })],
      { 'c1/7': { kind: 'conflicted' } },
      {
        unusableEdits: [
          {
            key: { connectionId: 'c1', nodeId: 9 },
            endpoint: 'https://raphael.example',
            nodeType: 'area',
            title: 'kept',
            problem: 'unsupported_content_schema',
          },
        ],
      },
    );

    assert.deepEqual(
      rows.map((row) => row.standing),
      ['unusable', 'conflicted'],
    );
    assert.deepEqual(rows[0].actions, ['discard']);
    assert.equal(rows[0].problem, 'unsupported_content_schema');
    assert.equal(rows[0].key, 'unusable-edit:c1/9');
  });

  it('invents nothing about a row whose columns could not be read', () => {
    const rows = listed(
      [],
      {},
      {
        unusableEdits: [
          {
            key: { connectionId: 'c1', nodeId: 9 },
            endpoint: null,
            nodeType: null,
            title: null,
            problem: 'unreadable_row',
          },
        ],
      },
    );

    assert.equal(rows[0].title, '');
    assert.equal(rows[0].nodeType, null);
    assert.equal(rows[0].endpoint, null);
    // Nothing about it is known to have happened at a time this build can read.
    assert.equal(rows[0].activityAt, 0);
  });

  it('namespaces its keys so an edit and an unusable row are different cards', () => {
    const rows = listed(
      [record(9)],
      { 'c1/9': { kind: 'pending' } },
      {
        unusableEdits: [
          {
            key: { connectionId: 'c1', nodeId: 9 },
            endpoint: null,
            nodeType: null,
            title: null,
            problem: 'unreadable_row',
          },
        ],
      },
    );

    assert.equal(new Set(rows.map((row) => row.key)).size, 2);
  });
});
