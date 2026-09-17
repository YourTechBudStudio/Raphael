/**
 * Where one edit record stands.
 *
 * The evaluation order is the thing under test, because every wrong ordering tells someone something
 * false about writing that is not on a server yet. Two cases carry most of the weight: an in-flight
 * envelope nobody is flying is `unconfirmed` rather than `saving`, and a record with nothing to send
 * is `synced` whatever the connectivity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { editStandingOf } from '../src/modules/capture/edit-policy.ts';

const record = (over = {}) => ({
  key: { connectionId: 'c1', nodeId: 7 },
  endpoint: 'https://raphael.example',
  nodeType: 'resource',
  kind: 'note',
  base: { title: 'a', description: '', slug: 'a', tags: [], document: {} },
  baseRevision: 4,
  content: { title: 'a', description: '', slug: 'a', tags: [], document: {} },
  contentSchemaVersion: 1,
  draftVersion: 3,
  acknowledgedVersion: 3,
  inflightVersion: null,
  inflight: null,
  syncState: 'syncing',
  lastRefusal: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const standing = (over = {}, input = {}) =>
  editStandingOf({
    record: record(over),
    committedVersion: 3,
    sending: false,
    sessionUsable: true,
    ...input,
  });

const REFUSAL = { code: 'slug_conflict', field: 'slug', reason: null, at: 10 };

describe('editStandingOf', () => {
  it('reports synced at the base revision when nothing is unsent', () => {
    assert.deepEqual(standing(), { kind: 'synced', revision: 4 });
  });

  it('reports pending when a committed version is past the acknowledged one', () => {
    assert.deepEqual(standing({ acknowledgedVersion: 2 }), { kind: 'pending' });
  });

  it('reports offline when there is unsent writing and no usable session', () => {
    assert.deepEqual(standing({ acknowledgedVersion: 2 }, { sessionUsable: false }), {
      kind: 'offline',
    });
  });

  it('reports synced with no usable session when there is nothing to send', () => {
    // The mirror-image overclaim: saying "kept on this phone" over writing already on the server.
    assert.deepEqual(standing({}, { sessionUsable: false }), { kind: 'synced', revision: 4 });
  });

  it('measures unsent writing against the committed version, never the latest accepted one', () => {
    // A version that is not on disk cannot be sent, so it must not be reported as waiting to go.
    assert.deepEqual(
      standing({ draftVersion: 9, acknowledgedVersion: 3 }, { committedVersion: 3 }),
      {
        kind: 'synced',
        revision: 4,
      },
    );
  });

  it('reports saving only while this process is flying the envelope', () => {
    assert.deepEqual(standing({ inflightVersion: 4 }, { sending: true }), { kind: 'saving' });
  });

  it('reports unconfirmed for an envelope in flight with no dispatcher', () => {
    // What a record read back after a process death looks like. "Saving" would claim a request that
    // no longer exists.
    assert.deepEqual(standing({ inflightVersion: 4 }, { sending: false }), { kind: 'unconfirmed' });
  });

  it('reports refused with the stored refusal', () => {
    assert.deepEqual(standing({ syncState: 'refused', lastRefusal: REFUSAL }), {
      kind: 'refused',
      refusal: REFUSAL,
    });
  });

  it('reports refused with a null refusal when the diagnostic could not be read', () => {
    assert.deepEqual(standing({ syncState: 'refused', lastRefusal: null }), {
      kind: 'refused',
      refusal: null,
    });
  });

  it('reports conflicted', () => {
    assert.deepEqual(standing({ syncState: 'conflicted' }), { kind: 'conflicted' });
  });

  describe('precedence', () => {
    it('puts conflicted above refusal, in flight and unsent writing alike', () => {
      assert.deepEqual(
        standing(
          {
            syncState: 'conflicted',
            lastRefusal: REFUSAL,
            inflightVersion: 4,
            acknowledgedVersion: 1,
          },
          { sending: true, sessionUsable: false },
        ),
        { kind: 'conflicted' },
      );
    });

    it('puts refusal above in flight and unsent writing', () => {
      assert.deepEqual(
        standing(
          {
            syncState: 'refused',
            lastRefusal: REFUSAL,
            inflightVersion: 4,
            acknowledgedVersion: 1,
          },
          { sending: true, sessionUsable: false },
        ),
        { kind: 'refused', refusal: REFUSAL },
      );
    });

    it('puts unconfirmed above offline', () => {
      // A lost answer stays unresolved whether or not the phone is connected now.
      assert.deepEqual(
        standing({ inflightVersion: 4, acknowledgedVersion: 1 }, { sessionUsable: false }),
        { kind: 'unconfirmed' },
      );
    });

    it('puts offline above pending', () => {
      // "Saving soon" is a lie when nothing can be sent.
      assert.deepEqual(standing({ acknowledgedVersion: 1 }, { sessionUsable: false }), {
        kind: 'offline',
      });
    });
  });
});
