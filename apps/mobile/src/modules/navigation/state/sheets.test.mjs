/**
 * One overlay at a time, and no destination decided before the sheet opens.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { useSheetsStore } from './sheets.ts';

const reset = () => {
  useSheetsStore.setState({ open: null, session: 0 });
};

test('the two capture sheets share one open-sheet owner', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openNewNote();
  assert.equal(useSheetsStore.getState().open, 'new-note');

  actions.openVoiceCapture();
  assert.equal(useSheetsStore.getState().open, 'voice-capture', 'opening one closes the other');

  actions.close();
  assert.equal(useSheetsStore.getState().open, null);
});

test('every opening is its own session, so a sheet never reopens on the last one', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openNewNote();
  const first = useSheetsStore.getState().session;
  actions.close();
  actions.openNewNote();

  assert.notEqual(useSheetsStore.getState().session, first);
});

test('nothing here can open container creation, or name where a capture lands', () => {
  reset();
  const actions = useSheetsStore.getState();

  // Phase 09 owns container creation. The action was removed rather than hidden, so a stray caller
  // is a compile error and this boundary is checkable rather than something a reviewer must trust.
  assert.equal(actions.openNewContainer, undefined);
  assert.equal(actions.resumeContainer, undefined);
  // And a capture target cannot be handed in: the destination is chosen inside the sheet, every
  // time, which is what removed the silent inbox.
  assert.equal(useSheetsStore.getState().captureTarget, undefined);
  assert.equal(useSheetsStore.getState().containerTarget, undefined);
});
