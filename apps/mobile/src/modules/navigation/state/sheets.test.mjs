/**
 * One overlay at a time, and what each one is allowed to carry.
 *
 * The rule worth checking is not that the store holds a string. It is that a capture sheet can
 * never be handed a destination - that is what removed the silent inbox - while a creation sheet
 * always carries the one that was tapped, and a resume carries only a durable id rather than a copy
 * of a record that is deliberately immutable.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { useSheetsStore } from './sheets.ts';

const reset = () => {
  useSheetsStore.setState({ open: null, session: 0 });
};

test('every sheet shares one open-sheet owner', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openNewNote();
  assert.deepEqual(useSheetsStore.getState().open, { kind: 'new-note' });

  actions.openVoiceCapture();
  assert.equal(
    useSheetsStore.getState().open.kind,
    'voice-capture',
    'opening one closes the other',
  );

  actions.openNewContainer('project', 4);
  assert.equal(useSheetsStore.getState().open.kind, 'new-container');

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

test('a creation carries the destination that was tapped, including the root', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openNewContainer('project', 12);
  assert.deepEqual(useSheetsStore.getState().open, {
    kind: 'new-container',
    containerType: 'project',
    parentAreaId: 12,
  });

  // The root is a real destination and is spelled out, not left to be inferred from an absent id.
  actions.openNewContainer('area', null);
  assert.deepEqual(useSheetsStore.getState().open, {
    kind: 'new-container',
    containerType: 'area',
    parentAreaId: null,
  });
});

test('resuming carries a durable id and nothing copied from the record', () => {
  reset();
  useSheetsStore.getState().resumeContainer('attempt-7');

  const open = useSheetsStore.getState().open;

  assert.deepEqual(open, { kind: 'resume-container', attemptId: 'attempt-7' });
  // No title, no parent, no frozen request. The owner loads and validates the record; a copy here
  // would be a second version of something that must not have two.
  assert.equal(Object.keys(open).length, 2);
});

test('a capture sheet cannot be told where to write', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openNewNote();

  // The destination is chosen inside the sheet, every time. There is no argument to pass and no
  // field to read, so the removal is structural rather than a check somewhere in the sheet.
  assert.equal(actions.openNewNote.length, 0);
  assert.equal(actions.openVoiceCapture.length, 0);
  assert.equal(Object.keys(useSheetsStore.getState().open).length, 1);
  assert.equal(useSheetsStore.getState().captureTarget, undefined);
});
