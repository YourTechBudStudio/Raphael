/**
 * Every lifecycle sentence branch, and the two rules they share: wording follows the resulting
 * state, and nothing claims a refresh that did not happen.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionFailureSentence,
  archivedAlongside,
  archivedRefusalSentence,
  briefOutcome,
  iconToggleSpokenLabel,
  ARCHIVED_PARENT_CREATION_SENTENCE,
  inheritedLine,
  inheritedLineParts,
  outcomeSentence,
  readOnlyDetailsSubtitle,
  statusSentence,
  toggleHint,
  toggleSpokenLabel,
} from './copy.ts';
import { lifecycleView } from './view.ts';

const NOTE = 41;
const cause = (id, type, title, owner = 'user', reason = 'direct') => ({
  origin: { id, type, title },
  owner,
  reason,
});
const own = cause(NOTE, 'resource', 'Runbook');
const project = cause(12, 'project', 'Auth rework');
const area = cause(5, 'area', 'Work');
const foreign = cause(NOTE, 'resource', 'Runbook', 'retention', 'expired');

const active = lifecycleView(NOTE, []);
const direct = lifecycleView(NOTE, [own]);
const inherited = lifecycleView(NOTE, [project, area]);
const both = lifecycleView(NOTE, [own, project, area]);
const other = lifecycleView(NOTE, [foreign]);

const conflict = {
  kind: 'api_error',
  message: 'The revision is stale.',
  error: { code: 'revision_conflict', message: 'stale' },
  details: {},
};
const failed = {
  kind: 'api_error',
  message: 'Your server refused this.',
  error: { code: 'invalid_input', message: 'nope' },
  details: {},
};

test('spoken labels say what pressing does; the visible word is never the verb', () => {
  assert.equal(toggleSpokenLabel(active, 'Auth rework'), 'Archive Auth rework');
  assert.equal(toggleSpokenLabel(inherited, 'Auth rework'), 'Archive Auth rework');
  assert.equal(toggleSpokenLabel(direct, 'Auth rework'), 'Restore Auth rework');
  assert.equal(iconToggleSpokenLabel(active, 'note'), 'Archive this note');
  assert.equal(iconToggleSpokenLabel(both, 'note'), 'Restore this note');
  assert.equal(iconToggleSpokenLabel(null, 'project'), 'Archive this project');
  assert.equal(toggleHint(active), 'Hides it from lists and search. Nothing is deleted');
  assert.equal(toggleHint(null), 'Hides it from lists and search. Nothing is deleted');
  assert.equal(
    toggleHint(inherited),
    'Adds your own archive, so it stays archived when Project “Auth rework” is restored',
  );
  assert.equal(
    toggleHint(other),
    'Adds your own archive, so it stays archived whatever else is removed',
  );
  assert.equal(toggleHint(direct), 'Brings it back to lists and search');
});

test('Restore promises lists and search back only when nothing else keeps it archived', () => {
  assert.equal(
    toggleHint(both),
    'Removes your archive. It stays archived with Project “Auth rework”',
  );
  assert.equal(
    toggleHint(lifecycleView(NOTE, [own, foreign])),
    'Removes your archive. It stays archived by retention',
  );
});

test('read-only Details names the way back for what keeps it archived', () => {
  assert.equal(
    readOnlyDetailsSubtitle(direct),
    'Archived, so these cannot change. Restore it to edit them.',
  );
  assert.equal(
    readOnlyDetailsSubtitle(inherited),
    'Archived with Project “Auth rework”, so these cannot change. Move it somewhere active, or restore that container, to edit them.',
  );
  assert.equal(
    readOnlyDetailsSubtitle(both),
    'Archived, so these cannot change. Restore it and Project “Auth rework” to edit them.',
  );
  assert.equal(readOnlyDetailsSubtitle(other), 'Archived by retention, so these cannot change.');
  assert.equal(
    readOnlyDetailsSubtitle(lifecycleView(NOTE, [own, foreign])),
    'Archived, so these cannot change. Restoring it still leaves it archived by retention.',
  );
  // An inherited-only entity's toggle archives, so its subtitle must not tell it to restore itself.
  assert.doesNotMatch(readOnlyDetailsSubtitle(inherited), /Restore it/);
});

test('writing not on the server is still said while archived', () => {
  assert.equal(
    archivedAlongside('Your server refused the last change · it is archived'),
    'Archived · Your server refused the last change · it is archived',
  );
});

test('the inherited line names the nearest container above, and nothing for your own cause alone', () => {
  assert.equal(inheritedLine(active), null);
  assert.equal(inheritedLine(direct), null);
  assert.equal(inheritedLine(inherited), 'Archived with Project “Auth rework”');
  assert.equal(inheritedLine(both), 'Also archived with Project “Auth rework”');
  assert.equal(inheritedLine(other), 'Archived by retention');
});

test('the inherited line splits at the name the screen draws as the part that opens it', () => {
  assert.equal(inheritedLineParts(direct), null);
  assert.deepEqual(inheritedLineParts(inherited), {
    lead: 'Archived with ',
    origin: 'Project “Auth rework”',
  });
  assert.deepEqual(inheritedLineParts(both), {
    lead: 'Also archived with ',
    origin: 'Project “Auth rework”',
  });
  // Another owner's cause names nowhere to go.
  assert.deepEqual(inheritedLineParts(other), { lead: 'Archived by retention', origin: null });
});

test('a creation refused for an archived parent asks for nothing the form cannot do', () => {
  assert.equal(
    ARCHIVED_PARENT_CREATION_SENTENCE,
    'That area was archived, so nothing can be added to it.',
  );
  assert.doesNotMatch(ARCHIVED_PARENT_CREATION_SENTENCE, /[Pp]ick/);
});

test('the status line says why the screen is read-only, the inherited reason first', () => {
  assert.equal(statusSentence(active, null), null);
  assert.equal(statusSentence(null, null), null);
  assert.equal(statusSentence(direct, null), 'Archived · read only');
  assert.equal(statusSentence(inherited, null), 'Archived with Project “Auth rework” · read only');
  // The user's own cause does not hide the container above: restoring it would leave this read-only.
  assert.equal(statusSentence(both, null), 'Archived with Project “Auth rework” · read only');
  assert.equal(statusSentence(other, null), 'Archived by retention · read only');
  assert.equal(
    statusSentence(lifecycleView(12, [area]), null),
    'Archived with Area “Work” · read only',
  );
});

test('a running request is said whatever the standing, even when the causes are unknown', () => {
  assert.equal(statusSentence(active, 'archive'), 'Archiving…');
  assert.equal(statusSentence(direct, 'restore'), 'Restoring…');
  assert.equal(statusSentence(null, 'archive'), 'Archiving…');
});

test('a success is worded from the resulting state, not the verb', () => {
  const done = (causes) => ({ kind: 'done', archived: causes.length > 0, causes });

  assert.equal(outcomeSentence('archive', done([own]), NOTE), null);
  assert.equal(outcomeSentence('restore', done([]), NOTE), null);
  assert.equal(
    outcomeSentence('restore', done([project, area]), NOTE),
    'Still archived with Project “Auth rework”.',
  );
  assert.equal(outcomeSentence('restore', done([foreign]), NOTE), 'Still archived by retention.');
});

test('a refresh is claimed only when the read-back succeeded', () => {
  assert.equal(
    outcomeSentence('archive', { kind: 'refused', failure: conflict, reread: true }, NOTE),
    'This changed since you looked. Refreshed; try again.',
  );
  assert.equal(
    outcomeSentence('archive', { kind: 'refused', failure: conflict, reread: false }, NOTE),
    'This changed since you looked, and Raphael could not read it again. Reopen it before trying again.',
  );
  assert.equal(
    outcomeSentence('restore', { kind: 'unconfirmed', reread: true }, NOTE),
    'Raphael could not confirm this. Showing what your server holds now.',
  );
  assert.equal(
    outcomeSentence('restore', { kind: 'unconfirmed', reread: false }, NOTE),
    'Raphael could not confirm this, or read what your server holds now. What you see may be out of date.',
  );
  assert.equal(
    outcomeSentence('archive', { kind: 'refused', failure: failed, reread: true }, NOTE),
    'Your server refused this.',
  );

  for (const outcome of [
    { kind: 'refused', failure: conflict, reread: false },
    { kind: 'refused', failure: failed, reread: false },
    { kind: 'unconfirmed', reread: false },
  ]) {
    assert.doesNotMatch(outcomeSentence('archive', outcome, NOTE) ?? '', /[Rr]efreshed|[Ss]howing/);
  }
});

test('container failure lines make no claim about a refresh', () => {
  assert.equal(
    actionFailureSentence('conflict', ''),
    'This changed since you looked. Check it, then try again.',
  );
  assert.equal(
    actionFailureSentence('unconfirmed', ''),
    'Raphael could not confirm this. Check it before trying again.',
  );
  assert.equal(
    actionFailureSentence('failed', 'Your server refused this.'),
    'Your server refused this.',
  );

  for (const failure of ['conflict', 'unconfirmed', 'failed']) {
    assert.doesNotMatch(actionFailureSentence(failure, 'x'), /[Rr]efreshed|[Ss]howing/);
  }
});

test('a node_archived refusal is advised by what is archived and how', () => {
  assert.equal(
    archivedRefusalSentence({ field: 'target', reason: 'direct' }),
    'This is archived. Restore it first.',
  );
  assert.equal(
    archivedRefusalSentence({ field: 'target', reason: 'inherited' }),
    'This is archived with a container above it. Move it somewhere active, or restore that container.',
  );
  assert.equal(
    archivedRefusalSentence({ field: 'parent', reason: 'inherited' }),
    'That place is archived. Pick another.',
  );
  assert.equal(
    archivedRefusalSentence({ field: 'destination', reason: 'direct' }),
    'That place is archived. Pick another.',
  );
  assert.equal(archivedRefusalSentence({ field: 'target', reason: 'later' }), 'This is archived.');
  assert.equal(archivedRefusalSentence({}), 'This is archived.');
});

test('a failed action is still distinguishable in a few words', () => {
  assert.equal(
    briefOutcome('archive', { kind: 'refused', failure: conflict, reread: true }),
    'Archive refused: this changed since you looked',
  );
  assert.equal(
    briefOutcome('restore', { kind: 'refused', failure: failed, reread: false }),
    'Restore refused by your server',
  );
  assert.equal(
    briefOutcome('archive', { kind: 'unconfirmed', reread: true }),
    'Archive not confirmed',
  );
  assert.equal(briefOutcome('restore', { kind: 'not_sent' }), 'Restore not sent');
});
