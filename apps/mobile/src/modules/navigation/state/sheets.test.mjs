import assert from 'node:assert/strict';
import test from 'node:test';

import { useSheetsStore } from './sheets.ts';

test('capture and creation share one open-sheet owner and preserve their targets', () => {
  const actions = useSheetsStore.getState();
  const project = { type: 'project', id: 'project-1' };
  try {
    actions.openNewNote(project);
    assert.equal(useSheetsStore.getState().open, 'new-note');
    assert.deepEqual(useSheetsStore.getState().captureTarget, project);

    actions.openVoiceCapture({ type: 'home' });
    assert.equal(useSheetsStore.getState().open, 'voice-capture');
    assert.deepEqual(useSheetsStore.getState().captureTarget, { type: 'home' });

    actions.openNewContainer({ type: 'project', parentAreaId: 'area-1' });
    assert.equal(useSheetsStore.getState().open, 'new-container');
    assert.deepEqual(useSheetsStore.getState().containerTarget, {
      type: 'project',
      parentAreaId: 'area-1',
    });

    actions.openNewContainer({ type: 'area', parentAreaId: null });
    assert.equal(useSheetsStore.getState().open, 'new-container');
    assert.equal(useSheetsStore.getState().containerTarget.parentAreaId, null);
    assert.equal(useSheetsStore.getState().resumeAttempt, null);

    const pending = { type: 'area', parentAreaId: 'area-1', attemptKey: 'k1', title: 'Design' };
    actions.resumeContainer(pending);
    assert.equal(useSheetsStore.getState().open, 'new-container');
    assert.deepEqual(useSheetsStore.getState().containerTarget, {
      type: 'area',
      parentAreaId: 'area-1',
    });
    assert.deepEqual(useSheetsStore.getState().resumeAttempt, pending);

    actions.openNewContainer({ type: 'project', parentAreaId: 'area-1' });
    assert.equal(useSheetsStore.getState().resumeAttempt, null);

    actions.close();
    assert.equal(useSheetsStore.getState().open, null);
  } finally {
    useSheetsStore.setState(useSheetsStore.getInitialState(), true);
  }
});

test('every opening of the creation sheet is its own session', () => {
  const actions = useSheetsStore.getState();
  const root = { type: 'area', parentAreaId: null };
  try {
    actions.openNewContainer(root);
    const first = useSheetsStore.getState().containerSession;

    // The sheet stays mounted while closed, so a second creation for the same destination has to
    // be distinguishable from the first, or it would reopen the finished state of the first.
    actions.close();
    actions.openNewContainer(root);
    const second = useSheetsStore.getState().containerSession;
    assert.notEqual(second, first, 'a fresh open of the same destination is a new session');

    const attempt = {
      ...root,
      attemptKey: 'k1',
      title: 'Design',
      description: '',
      body: '',
    };
    actions.resumeContainer(attempt);
    const resumed = useSheetsStore.getState().containerSession;
    assert.notEqual(resumed, second);
    assert.deepEqual(useSheetsStore.getState().resumeAttempt, attempt);

    // And an ordinary New after a resume is a blank form, not the attempt that was resumed.
    actions.openNewContainer(root);
    assert.notEqual(useSheetsStore.getState().containerSession, resumed);
    assert.equal(useSheetsStore.getState().resumeAttempt, null);
  } finally {
    useSheetsStore.setState(useSheetsStore.getInitialState(), true);
  }
});
