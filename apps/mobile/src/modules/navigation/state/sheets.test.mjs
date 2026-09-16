/**
 * One overlay at a time, and what each one is allowed to carry.
 *
 * The rule worth checking is not that the store holds a string. It is that the capture sheet can
 * never be handed a destination - that is what removed the silent inbox - while a creation sheet
 * always carries the one that was tapped.
 *
 * Text capture is not here at all. It is a route over a durable draft rather than an overlay, so
 * there is no `new-note` sheet to open and nothing left that could be handed a destination. Nor is
 * there a resume sheet: container creation has no durable record to resume.
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

  actions.openVoiceCapture();
  assert.deepEqual(useSheetsStore.getState().open, { kind: 'voice-capture' });

  actions.openNewContainer('project', 4);
  assert.equal(
    useSheetsStore.getState().open.kind,
    'new-container',
    'opening one closes the other',
  );

  actions.close();
  assert.equal(useSheetsStore.getState().open, null);
});

test('every opening is its own session, so a sheet never reopens on the last one', () => {
  reset();
  const actions = useSheetsStore.getState();

  actions.openVoiceCapture();
  const first = useSheetsStore.getState().session;
  actions.close();
  actions.openVoiceCapture();

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
