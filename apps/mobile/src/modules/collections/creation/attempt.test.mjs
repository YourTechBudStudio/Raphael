import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AFTER_EXPIRY_NOTICE,
  EMPTY_TITLE_PROBLEM,
  NOT_CREATED_NOTICE,
  RECORD_FAILED_PROBLEM,
  describeExpired,
  describeUncertain,
  draftOf,
  hasContent,
  initialCreation,
  isDraftEditable,
  leavesPendingAttempt,
  newAttemptKey,
  reduceCreation,
  resumedCreation,
} from './attempt.ts';

const target = { type: 'area', parentAreaId: 'creative-work' };
const design = {
  type: 'area',
  id: 'design',
  name: 'Design',
  description: '',
  body: '',
  parentAreaId: 'creative-work',
  emblem: 'layers',
};

const run = (state, ...events) => events.reduce(reduceCreation, state);
const edit = (field, value) => ({ type: 'edit', field, value });
const typed = (title) => run(initialCreation(target), edit('title', title));

test('an empty title is refused on Save, not while typing', () => {
  const state = initialCreation(target);
  assert.equal(state.phase.problem, null);
  const submitted = reduceCreation(state, { type: 'submit', key: 'k1' });
  assert.equal(submitted.phase.kind, 'editing');
  assert.equal(submitted.phase.problem, EMPTY_TITLE_PROBLEM);
  assert.equal(submitted.attemptKey, null, 'nothing was sent, so no attempt exists');
  const spaces = run(state, edit('title', '   '), { type: 'submit', key: 'k1' });
  assert.equal(spaces.phase.problem, EMPTY_TITLE_PROBLEM);
});

test('saving locks the title and fixes the attempt key', () => {
  const saving = run(typed('Design'), { type: 'submit', key: 'k1' });
  assert.equal(saving.phase.kind, 'saving');
  assert.equal(saving.attemptKey, 'k1');
  assert.equal(isDraftEditable(saving), false);
  const edited = run(
    saving,
    edit('title', 'Something else'),
    edit('description', 'sneaking this in'),
    edit('body', 'and this'),
  );
  assert.equal(edited.title, 'Design', 'a dispatched attempt cannot be edited underneath');
  assert.equal(edited.description, '', 'nor can the fields it carried');
  assert.equal(edited.body, '');
});

test('a collision keeps the title, ends the attempt, and typing starts a new one', () => {
  const refused = run(
    typed('Design'),
    { type: 'submit', key: 'k1' },
    {
      type: 'outcome',
      outcome: {
        kind: 'rejected',
        reason: 'collision',
        message: 'There is already an area called Design in Creative work.',
      },
    },
  );
  assert.equal(refused.phase.kind, 'editing');
  assert.equal(refused.title, 'Design');
  assert.match(refused.phase.problem, /already an area called Design/);
  assert.equal(refused.attemptKey, null, 'a refused key is spent');
  const corrected = run(refused, edit('title', 'Design system'), { type: 'submit', key: 'k2' });
  assert.equal(corrected.attemptKey, 'k2', 'the correction is a new logical attempt');
  assert.equal(corrected.phase.kind, 'saving');
});

test('a failed local record is not a sent attempt', () => {
  const state = run(typed('Design'), { type: 'submit', key: 'k1' }, { type: 'record_failed' });
  assert.equal(state.phase.kind, 'editing');
  assert.equal(state.phase.problem, RECORD_FAILED_PROBLEM);
  assert.equal(isDraftEditable(state), true);
  assert.equal(leavesPendingAttempt(state), false, 'nothing to keep: nothing left the phone');
});

test('an uncertain outcome locks the title and keeps the key for the retry', () => {
  const uncertain = run(
    typed('Design'),
    { type: 'submit', key: 'k1' },
    { type: 'outcome', outcome: { kind: 'uncertain' } },
  );
  assert.equal(uncertain.phase.kind, 'uncertain');
  assert.equal(isDraftEditable(uncertain), false);
  assert.equal(leavesPendingAttempt(uncertain), true);
  const retried = reduceCreation(uncertain, { type: 'retry' });
  assert.equal(retried.phase.kind, 'saving');
  assert.equal(retried.attemptKey, 'k1', 'a retry is the same attempt, not a second creation');
  const replayed = reduceCreation(retried, {
    type: 'outcome',
    outcome: { kind: 'created', collection: design },
  });
  assert.equal(replayed.phase.kind, 'created');
});

test('checking an uncertain attempt resolves it three ways', () => {
  const uncertain = run(
    typed('Design'),
    { type: 'submit', key: 'k1' },
    { type: 'outcome', outcome: { kind: 'uncertain' } },
  );
  const checking = reduceCreation(uncertain, { type: 'check' });
  assert.equal(checking.phase.checking, true);
  assert.equal(
    reduceCreation(checking, { type: 'retry' }).phase.kind,
    'uncertain',
    'no retry while a check is out',
  );

  const created = reduceCreation(checking, {
    type: 'check_result',
    result: { kind: 'created', collection: design },
  });
  assert.equal(created.phase.kind, 'created');

  const notCreated = reduceCreation(checking, {
    type: 'check_result',
    result: { kind: 'not_created' },
  });
  assert.equal(notCreated.phase.kind, 'editing');
  assert.equal(notCreated.phase.notice, NOT_CREATED_NOTICE);
  assert.equal(
    notCreated.attemptKey,
    'k1',
    'known not created: the same key is safe to send again',
  );
  assert.equal(run(notCreated, { type: 'submit', key: 'k9' }).attemptKey, 'k1');

  const expired = reduceCreation(checking, { type: 'check_result', result: { kind: 'expired' } });
  assert.equal(expired.phase.kind, 'expired');
  assert.equal(isDraftEditable(expired), false);
  assert.equal(leavesPendingAttempt(expired), true);
});

test('a check that gets no answer leaves the attempt as unresolved as it was', () => {
  const checking = run(
    typed('Design'),
    { type: 'submit', key: 'k1' },
    { type: 'outcome', outcome: { kind: 'uncertain' } },
    { type: 'check' },
  );
  const failed = reduceCreation(checking, { type: 'check_failed' });
  assert.equal(failed.phase.kind, 'uncertain');
  assert.equal(failed.phase.checking, false);
  assert.equal(failed.attemptKey, 'k1');
  assert.equal(isDraftEditable(failed), false, 'no answer is not permission to edit');
});

test('after expiry, creating again is explicit, new, and warned', () => {
  const expired = run(
    typed('Design'),
    { type: 'submit', key: 'k1' },
    { type: 'outcome', outcome: { kind: 'uncertain' } },
    { type: 'check' },
    { type: 'check_result', result: { kind: 'expired' } },
  );
  assert.equal(
    reduceCreation(expired, { type: 'retry' }).phase.kind,
    'expired',
    'no blind retry after expiry',
  );
  const again = reduceCreation(expired, { type: 'start_over' });
  assert.equal(again.phase.kind, 'editing');
  assert.equal(again.phase.notice, AFTER_EXPIRY_NOTICE);
  assert.equal(again.title, 'Design', 'the title is kept for the person to reuse or change');
  assert.equal(again.attemptKey, null);
  assert.equal(run(again, { type: 'submit', key: 'k2' }).attemptKey, 'k2');
});

test('a resumed attempt reopens unresolved with its whole payload untouched', () => {
  const attempt = {
    ...target,
    attemptKey: 'k1',
    title: 'Design',
    description: 'Shape how things look.',
    body: '## Why\n\nBecause it keeps coming up.',
  };
  const resumed = resumedCreation(attempt);
  assert.equal(resumed.phase.kind, 'uncertain');
  assert.equal(resumed.attemptKey, 'k1');
  assert.equal(isDraftEditable(resumed), false);
  assert.deepEqual(draftOf(resumed), {
    title: attempt.title,
    description: attempt.description,
    body: attempt.body,
  });
});

test('description and body are optional, trimmed, and count as work worth keeping', () => {
  const bare = run(initialCreation(target), edit('title', 'Design'));
  assert.deepEqual(draftOf(bare), { title: 'Design', description: '', body: '' });
  assert.equal(reduceCreation(bare, { type: 'submit', key: 'k1' }).phase.kind, 'saving');

  const full = run(
    initialCreation(target),
    edit('title', '  Design  '),
    edit('description', '  Shape how things look.  '),
    edit('body', '  ## Why\n\nBecause it keeps coming up.  '),
  );
  assert.deepEqual(draftOf(full), {
    title: 'Design',
    description: 'Shape how things look.',
    body: '## Why\n\nBecause it keeps coming up.',
  });

  assert.equal(hasContent(initialCreation(target)), false);
  assert.equal(hasContent(run(initialCreation(target), edit('description', 'x'))), true);
  assert.equal(hasContent(run(initialCreation(target), edit('body', 'x'))), true);
  assert.equal(hasContent(run(initialCreation(target), edit('title', '   '))), false);
});

test('the copy says what is known and nothing more', () => {
  assert.match(describeUncertain('Design', false), /can't tell whether Design was created/);
  assert.match(describeUncertain('Design', true), /Asking the server/);
  assert.match(
    describeExpired('Design', 'Creative work'),
    /Look in Creative work before creating it again/,
  );
  assert.match(describeExpired('Design', null), /Look at the top level/);
  assert.doesNotMatch(
    describeUncertain('Design', false),
    /was not created/,
    'uncertain never claims failure',
  );
});

test('attempt keys are unique across many draws', () => {
  const keys = new Set(Array.from({ length: 2000 }, newAttemptKey));
  assert.equal(keys.size, 2000);
});
