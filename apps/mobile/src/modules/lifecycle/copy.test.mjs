/**
 * Every lifecycle sentence branch: wording follows the resulting state, and a failed plain action
 * says why in one sentence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archivedAlongside,
  failedActionSentence,
  iconToggleSpokenLabel,
  inheritedLine,
  inheritedLineParts,
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

test('a failed plain action says what failed and why, in one sentence', () => {
  assert.equal(
    failedActionSentence('Couldn’t archive', { kind: 'network', message: 'x' }),
    'Couldn’t archive. Can’t reach your server.',
  );
  assert.equal(
    failedActionSentence('Couldn’t move', { kind: 'timeout', message: 'x' }),
    'Couldn’t move. Can’t reach your server.',
  );
  assert.equal(
    failedActionSentence('Couldn’t add to favorites', { kind: 'http', status: 502, message: 'x' }),
    'Couldn’t add to favorites. Your server had a problem, try again.',
  );
  assert.equal(
    failedActionSentence('Couldn’t archive', {
      kind: 'http',
      status: 409,
      code: 'revision_conflict',
      message: 'This changed on the server. It is now at revision 7.',
    }),
    'Couldn’t archive. It changed on your server, try again.',
  );
  assert.equal(
    failedActionSentence('Couldn’t move', {
      kind: 'http',
      status: 409,
      code: 'slug_conflict',
      message: '"idea" is already used here.',
    }),
    'Couldn’t move. "idea" is already used here.',
  );
});
