import assert from 'node:assert/strict';
import test from 'node:test';

import { offersRetry, staleSentence } from './hierarchy-presentation.ts';

const settled = {
  message: 'This server holds more than 20000 areas and projects.',
  retryable: false,
};
const contradiction = { message: 'The same container arrived twice.', retryable: true };

test('a retry is offered for anything that could plausibly answer differently', () => {
  assert.equal(offersRetry(null), true, 'an unreachable server is always worth another go');
  assert.equal(offersRetry(contradiction), true, 'the next reading may well be consistent');
  assert.equal(offersRetry(settled), false, 'a button that can only fail again is worse than none');
});

test('stale data over a failed refresh says what actually failed', () => {
  // The bug this replaces: every screen blamed the network, so a server that answered perfectly
  // well and was refused for what it answered with sent someone to check their connection.
  assert.match(staleSentence(null), /did not reach the server/);

  for (const refusal of [settled, contradiction]) {
    const sentence = staleSentence(refusal);
    assert.ok(sentence.includes(refusal.message), 'the refusal explains itself');
    assert.doesNotMatch(sentence, /did not reach the server/);
  }
});

test('the data is never disowned, whatever failed', () => {
  for (const refusal of [null, settled, contradiction]) {
    assert.match(staleSentence(refusal), /last complete reading/);
  }
});
