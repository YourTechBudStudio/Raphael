import assert from 'node:assert/strict';
import test from 'node:test';

import { useSheetsStore } from './sheets.ts';

test('Browse and capture share one open-sheet owner and preserve their targets', () => {
  const actions = useSheetsStore.getState();
  const project = { type: 'project', id: 'project-1' };
  try {
    actions.openBrowse(project);
    assert.equal(useSheetsStore.getState().open, 'browse');
    assert.deepEqual(useSheetsStore.getState().browseCurrent, project);

    actions.openNewNote(project);
    assert.equal(useSheetsStore.getState().open, 'new-note');
    assert.deepEqual(useSheetsStore.getState().captureTarget, project);

    actions.openVoiceCapture({ type: 'home' });
    assert.equal(useSheetsStore.getState().open, 'voice-capture');
    assert.deepEqual(useSheetsStore.getState().captureTarget, { type: 'home' });

    actions.openBrowse();
    assert.equal(useSheetsStore.getState().open, 'browse');
    assert.equal(useSheetsStore.getState().browseCurrent, null);

    actions.close();
    assert.equal(useSheetsStore.getState().open, null);
  } finally {
    useSheetsStore.setState(useSheetsStore.getInitialState(), true);
  }
});
