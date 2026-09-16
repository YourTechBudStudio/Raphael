/**
 * What the composer says, and what its one action is.
 *
 * The precedence is a correctness rule rather than a layout choice, so it is pinned here rather than
 * inferred from a rendered screen. The rule the file exists for: **protection outranks everything**.
 * A screen reporting "Saving to your server…" over writing this phone could not keep is telling
 * someone their work is safe in the one moment it is not.
 *
 * The second rule, from the human decision that overrides the mock: an unresolved save that has
 * since taken a refusal **keeps Retry and never becomes an ordinary Save**. The standing is where
 * that is decided; what is checked here is that the bar cannot contradict it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerView,
  KEPT_STATUS,
  PROTECTION_COPY,
  REFUSED_STATUS,
  SAVING_STATUS,
  UNCONFIRMED_STATUS,
  UNRECORDED_STATUS,
  WITHDRAWN_STATUS,
} from './composer.ts';

const protection = (over = {}) => ({
  committedVersion: 2,
  latestAcceptedVersion: 2,
  pending: false,
  writing: false,
  failedWrite: false,
  rendererUnknown: false,
  locked: false,
  attached: true,
  ...over,
});

const input = (over = {}) => ({
  standing: { kind: 'save' },
  protection: protection(),
  lastRejection: null,
  saving: false,
  hasContent: true,
  hasDestination: true,
  revision: null,
  hasRemainder: false,
  ...over,
});

const attempt = { attemptId: 'a1', clockAnomaly: false, lastOutcome: null };

test('an ordinary draft says it is kept here, and Save is the action', () => {
  const view = composerView(input());

  assert.equal(view.status.text, KEPT_STATUS);
  assert.equal(view.status.tone, 'quiet');
  assert.equal(view.action.kind, 'save');
  assert.equal(view.action.enabled, true);
  assert.equal(view.destinationFrozen, false);
});

test('Save waits for content and for somewhere to put it', () => {
  assert.equal(composerView(input({ hasContent: false })).action.enabled, false);
  assert.equal(composerView(input({ hasDestination: false })).action.enabled, false);
  // A title on its own is content; core owns the final word on whether it can address the note.
  assert.equal(composerView(input({ hasContent: true })).action.enabled, true);
});

test('a write this phone could not make outranks every server verdict', () => {
  const view = composerView(
    input({
      protection: protection({ failedWrite: true }),
      standing: { kind: 'retry', attempt },
      saving: true,
    }),
  );

  assert.equal(view.status.text, PROTECTION_COPY.failed_write);
  assert.equal(view.status.tone, 'alert');
  // Sending a version this phone could not keep would leave the server holding something the
  // person can never get back to here.
  assert.equal(view.action.enabled, false);
});

test('a document the editor would not hand over is its own sentence', () => {
  const view = composerView(
    input({ protection: protection({ rendererUnknown: true }), lastRejection: 'too_large' }),
  );

  assert.equal(view.status.text, PROTECTION_COPY.too_large);
  assert.equal(view.problem, 'too_large');
});

test('an editor that simply did not answer is not described as a failed write', () => {
  const view = composerView(input({ protection: protection({ rendererUnknown: true }) }));

  assert.equal(view.problem, 'unanswered');
  assert.notEqual(view.status.text, PROTECTION_COPY.failed_write);
  assert.equal(view.action.enabled, false);
});

test('a renderer that has answered since is not still a problem', () => {
  assert.equal(composerView(input({ lastRejection: 'too_large' })).problem, null);
});

test('an unresolved save shows Retry and freezes the destination', () => {
  const view = composerView(input({ standing: { kind: 'retry', attempt } }));

  assert.equal(view.status.text, UNCONFIRMED_STATUS);
  assert.equal(view.action.kind, 'retry');
  // The frozen request answers for this destination. Changing it would make those bytes mean
  // something else under a key the server may already have used.
  assert.equal(view.destinationFrozen, true);
});

test('a withdrawn replay offers nothing, and still does not say the note was not created', () => {
  const view = composerView(
    input({
      standing: { kind: 'blocked', reason: 'unresolved_ineligible', attempt },
    }),
  );

  assert.equal(view.status.text, WITHDRAWN_STATUS);
  assert.equal(view.action.kind, 'none');
  assert.ok(!view.status.text.includes('Not saved'));
});

test('a refusal with no earlier uncertainty is the one case that gets Save back', () => {
  const view = composerView(input({ standing: { kind: 'save_replacing', attempt } }));

  assert.equal(view.status.text, REFUSED_STATUS);
  assert.equal(view.action.kind, 'save');
  assert.equal(view.destinationFrozen, false);
});

test('a success this phone could not record offers the local write, never another creation', () => {
  const view = composerView(input({ standing: { kind: 'record_again', attempt } }));

  assert.equal(view.status.text, UNRECORDED_STATUS);
  assert.equal(view.status.tone, 'alert');
  assert.equal(view.action.kind, 'record_again');
});

test('a reconciled note says which revision it is, and offers no action', () => {
  const view = composerView(
    input({ standing: { kind: 'blocked', reason: 'created', attempt }, revision: 3 }),
  );

  assert.equal(view.status.text, 'On your server · revision 3');
  assert.equal(view.action.kind, 'none');
});

test('a remainder says the note is filed and that this writing is not', () => {
  const view = composerView(
    input({
      standing: { kind: 'blocked', reason: 'created', attempt },
      revision: 3,
      hasRemainder: true,
    }),
  );

  assert.ok(view.status.text.includes('revision 3'));
  assert.ok(view.status.text.includes('newer writing kept on this phone'));
  // Editing stays possible - the writing is still protected here - but there is no update to make.
  assert.equal(view.action.kind, 'none');
});

test('a save in flight locks the screen and says so', () => {
  const view = composerView(input({ saving: true }));

  assert.equal(view.status.text, SAVING_STATUS);
  assert.equal(view.locked, true);
  assert.equal(view.action.label, 'Saving…');
  assert.equal(view.action.enabled, false);
});

test('contradictory records refuse to guess', () => {
  const view = composerView(
    input({ standing: { kind: 'blocked', reason: 'inconsistent', attempt } }),
  );

  assert.equal(view.action.kind, 'none');
  assert.equal(view.status.tone, 'alert');
});
