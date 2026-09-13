import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HANDSHAKE_STEPS,
  describeVerifyFailure,
  handshakeRows,
  hasFieldProblem,
  inspectSetupInput,
} from './setup.ts';

test('both fields are judged in one press, not one at a time', () => {
  const problems = inspectSetupInput('not a url', '');
  assert.ok(problems.endpoint);
  assert.ok(problems.key);
  assert.equal(hasFieldProblem(problems), true);
});

test('a key is whatever the owner configured, of any length or alphabet', () => {
  // No floor, no character set. Only the absence of a key is a problem.
  for (const key of ['x', 'a key with spaces', '🔑', 'a'.repeat(200), '  padded  ']) {
    assert.equal(inspectSetupInput('https://raphael.example.com', key).key, undefined, key);
  }
});

test('a usable pair has nothing to say about it', () => {
  const problems = inspectSetupInput('https://raphael.example.com', 'a'.repeat(32));
  assert.deepEqual(problems, {});
  assert.equal(hasFieldProblem(problems), false);
});

test('surrounding whitespace on a pasted address is not the person’s problem', () => {
  assert.deepEqual(inspectSetupInput('  https://raphael.example.com  ', 'a'.repeat(32)), {});
});

test('plain http is accepted to any address', () => {
  // The owner's decision. Over http the key travels in the clear, and the screen does not argue.
  const key = 'a'.repeat(32);
  for (const address of [
    'http://localhost:4000',
    'http://10.0.2.2:4000',
    'http://192.168.1.40:4000',
    'http://raphael.example.com',
  ]) {
    assert.equal(inspectSetupInput(address, key).endpoint, undefined, address);
  }
});

test('an address that cannot carry a credential is still refused', () => {
  // These are not transport-security rules: a key in a URL leaks into logs and shell history
  // whatever the scheme, and a non-HTTP scheme is not something this client speaks.
  const key = 'a'.repeat(32);
  assert.ok(inspectSetupInput('https://user:secret@example.com', key).endpoint);
  assert.ok(inspectSetupInput('ftp://raphael.example.com', key).endpoint);
  assert.ok(inspectSetupInput('https://example.com?x=1', key).endpoint);
});

test('empty fields ask for what is missing rather than reciting a rule', () => {
  const problems = inspectSetupInput('', '');
  assert.match(problems.endpoint ?? '', /Enter the address/);
  assert.match(problems.key ?? '', /Paste the API key/);
});

/**
 * The screen may never claim to know something the client did not tell it. These assertions are
 * about meaning, not phrasing: a timeout is not a refusal, and an opaque transport error is not
 * evidence that the address is wrong.
 */

test('a timeout says the server was silent, and that nothing was saved', () => {
  const { title, detail } = describeVerifyFailure({
    kind: 'timeout',
    timeoutMs: 15_000,
    mutationOutcome: 'not_applicable',
    message: 'The server did not answer in time.',
  });
  assert.match(title, /did not answer/i);
  assert.match(detail, /nothing was saved/i);
  // A diagnostic, not a sentence for a person.
  assert.doesNotMatch(`${title} ${detail}`, /\d+\s*ms/);
});

test('an unreachable address names every possibility instead of choosing one', () => {
  const { detail } = describeVerifyFailure({
    kind: 'transport',
    mutationOutcome: 'unknown',
    message: 'The server could not be reached.',
  });
  // React Native cannot tell these apart, so the copy must not pretend it can.
  assert.match(detail, /not running/i);
  assert.match(detail, /wrong address/i);
  assert.match(detail, /network/i);
});

test('a refused key says the server was reached, because it was', () => {
  const { title, detail } = describeVerifyFailure({
    kind: 'api_error',
    status: 401,
    mutationOutcome: 'rejected',
    message: 'Unauthorized.',
    error: { code: 'unauthorized', kind: 'client' },
    details: {},
  });
  assert.match(title, /key was refused/i);
  assert.match(detail, /there and answering/i);
});

test('a redirect explains the refusal in terms of the key, not the status code', () => {
  const { detail } = describeVerifyFailure({
    kind: 'invalid_response',
    reason: 'redirect_refused',
    status: 302,
    mutationOutcome: 'not_applicable',
    message: 'Redirect refused.',
  });
  assert.match(detail, /key/i);
  assert.doesNotMatch(detail, /302|3xx/);
});

test('anything unreadable is reported as not-Raphael rather than as a parser error', () => {
  const reasons = [
    'unexpected_status',
    'empty_response',
    'invalid_utf8',
    'malformed_json',
    'invalid_payload',
    'inconsistent_error',
    'unrecognized_error',
  ];
  for (const reason of reasons) {
    const { title, detail } = describeVerifyFailure({
      kind: 'invalid_response',
      reason,
      mutationOutcome: 'not_applicable',
      message: 'unreadable',
    });
    assert.match(title, /not Raphael/i, reason);
    assert.doesNotMatch(`${title} ${detail}`, /JSON|UTF-8|payload|envelope/i, reason);
  }
});

test('a version mismatch passes through the shared wording, which is not terminal jargon', () => {
  const { title, detail } = describeVerifyFailure({
    kind: 'invalid_response',
    reason: 'incompatible_protocol',
    mutationOutcome: 'not_applicable',
    message: 'This server speaks protocol 2; Raphael here understands 1. Update Raphael here.',
  });
  assert.match(title, /different version/i);
  assert.match(detail, /Update Raphael here/);
});

test('every failure the client can produce has something to say', () => {
  const failures = [
    { kind: 'invalid_request', mutationOutcome: 'not_dispatched', message: 'x', path: [] },
    { kind: 'timeout', mutationOutcome: 'not_applicable', message: 'x', timeoutMs: 1000 },
    { kind: 'cancelled', mutationOutcome: 'not_dispatched', message: 'x' },
    { kind: 'transport', mutationOutcome: 'unknown', message: 'x' },
    { kind: 'unsupported_fetch', mutationOutcome: 'not_dispatched', message: 'x' },
    {
      kind: 'api_error',
      status: 500,
      mutationOutcome: 'unknown',
      message: 'x',
      error: { code: 'internal_error', kind: 'server' },
      details: {},
    },
    {
      kind: 'invalid_response',
      reason: 'response_too_large',
      mutationOutcome: 'not_applicable',
      message: 'x',
    },
  ];
  for (const failure of failures) {
    const problem = describeVerifyFailure(failure);
    assert.ok(problem.title.length > 0, failure.kind);
    assert.ok(problem.detail.length > 0, failure.kind);
  }
});

/**
 * The handshake is the screen's argument: verification is a sequence, and where a failure lands
 * says how much it proved. Two rules are load-bearing.
 *
 * One is ordering. An earlier draft put "the key is accepted" before "the server answers", so a
 * refused key left the server unproven while the copy beside it said the server was answering.
 *
 * The other is that a row exists only when there is something true to say about it. A greyed-out
 * row for a condition nobody has asked about reads as a hurdle the person has to clear before the
 * button will work, which is the opposite of what this list is.
 */

const GOOD_ADDRESS = 'https://raphael.example.com';
const GOOD_KEY = 'a'.repeat(32);
const BOTH_SETTLED = { endpoint: true, key: true };

const view = (over = {}) =>
  handshakeRows({
    endpoint: GOOD_ADDRESS,
    key: GOOD_KEY,
    settled: BOTH_SETTLED,
    attempted: false,
    phase: { kind: 'idle' },
    ...over,
  });

const steps = (rows) => rows.map((row) => row.step);
const stateOf = (rows, step) => rows.find((row) => row.step === step)?.state;

test('an untouched screen shows the two local checks and nothing else', () => {
  const rows = view({ endpoint: '', key: '', settled: { endpoint: false, key: false } });
  assert.deepEqual(steps(rows), ['address', 'key']);
  assert.ok(rows.every((row) => row.state === 'pending'));
  assert.ok(rows.every((row) => row.problem === undefined));
});

test('typing a usable address confirms it without sending anything', () => {
  const rows = view({ key: '', settled: { endpoint: false, key: false } });
  assert.equal(stateOf(rows, 'address'), 'done');
  // An empty key is unfinished, not wrong.
  assert.equal(stateOf(rows, 'key'), 'pending');
  assert.deepEqual(steps(rows), ['address', 'key']);
});

test('a half-typed address is not accused of being wrong', () => {
  const rows = view({ endpoint: 'https:/', settled: { endpoint: false, key: false } });
  assert.equal(stateOf(rows, 'address'), 'pending');
  assert.equal(rows[0].problem, undefined);
});

test('leaving an unusable field is when it finally says why', () => {
  const rows = view({ endpoint: 'https:/' });
  assert.equal(stateOf(rows, 'address'), 'failed');
  assert.match(rows[0].problem?.detail ?? '', /valid URL/i);
});

test('a blank field is left alone until Connect is pressed', () => {
  const blank = { endpoint: '', key: '', settled: BOTH_SETTLED };
  // Tabbing past an empty field is unfinished, not wrong.
  assert.ok(view(blank).every((row) => row.state === 'pending'));

  // Pressing Connect is a declaration of being done, so the button must not look inert.
  const rows = view({ ...blank, attempted: true });
  assert.equal(stateOf(rows, 'address'), 'failed');
  assert.equal(stateOf(rows, 'key'), 'failed');
  assert.match(rows[1].problem?.detail ?? '', /Paste the API key/);
});

test('both fields can be wrong at once, and each says its own reason', () => {
  const rows = view({ endpoint: 'nonsense', key: '', attempted: true });
  assert.equal(stateOf(rows, 'address'), 'failed');
  assert.equal(stateOf(rows, 'key'), 'failed');
  assert.notEqual(rows[0].problem?.detail, rows[1].problem?.detail);
});

test('while connecting, only the condition being established is on screen', () => {
  const rows = view({ phase: { kind: 'verifying' } });
  assert.deepEqual(steps(rows), ['address', 'key', 'reachable']);
  assert.equal(stateOf(rows, 'reachable'), 'running');
  // Nothing has been asked about these yet, so they are not there to be waited on.
  assert.equal(stateOf(rows, 'accepted'), undefined);
  assert.equal(stateOf(rows, 'version'), undefined);
});

test('a refused key proves the server was reached, and proves nothing about its version', () => {
  const problem = describeVerifyFailure({
    kind: 'api_error',
    status: 401,
    mutationOutcome: 'rejected',
    message: 'Unauthorized.',
    error: { code: 'unauthorized', kind: 'client' },
    details: {},
  });
  assert.equal(problem.step, 'accepted');

  const rows = view({ phase: { kind: 'failed', problem } });
  assert.deepEqual(steps(rows), ['address', 'key', 'reachable', 'accepted']);
  assert.equal(stateOf(rows, 'reachable'), 'done');
  assert.equal(stateOf(rows, 'accepted'), 'failed');
  assert.equal(stateOf(rows, 'version'), undefined);
});

test('an unreachable server proves only the two local checks', () => {
  const problem = describeVerifyFailure({
    kind: 'transport',
    mutationOutcome: 'unknown',
    message: 'The server could not be reached.',
  });
  assert.equal(problem.step, 'reachable');

  const rows = view({ phase: { kind: 'failed', problem } });
  assert.deepEqual(steps(rows), ['address', 'key', 'reachable']);
  assert.equal(stateOf(rows, 'address'), 'done');
  assert.equal(stateOf(rows, 'reachable'), 'failed');
});

test('a version mismatch means everything before it held', () => {
  const problem = describeVerifyFailure({
    kind: 'invalid_response',
    reason: 'incompatible_protocol',
    mutationOutcome: 'not_applicable',
    message: 'This server speaks protocol 2; Raphael here understands 1. Update Raphael here.',
  });
  assert.equal(problem.step, 'version');

  const rows = view({ phase: { kind: 'failed', problem } });
  assert.equal(rows.length, HANDSHAKE_STEPS.length);
  for (const step of ['address', 'key', 'reachable', 'accepted']) {
    assert.equal(stateOf(rows, step), 'done', step);
  }
  assert.equal(stateOf(rows, 'version'), 'failed');
});

test('the explanation sits on the condition it broke, and nowhere else', () => {
  const problem = describeVerifyFailure({
    kind: 'timeout',
    timeoutMs: 15_000,
    mutationOutcome: 'not_applicable',
    message: 'The server did not answer in time.',
  });
  const carrying = view({ phase: { kind: 'failed', problem } }).filter(
    (row) => row.problem !== undefined,
  );
  assert.equal(carrying.length, 1);
  assert.equal(carrying[0].step, 'reachable');
});

test('a network failure never leaves a local check looking unresolved', () => {
  // The fields were good enough to dispatch, so they stay confirmed while the network row fails.
  const problem = describeVerifyFailure({
    kind: 'transport',
    mutationOutcome: 'unknown',
    message: 'x',
  });
  const rows = view({
    settled: { endpoint: false, key: false },
    phase: { kind: 'failed', problem },
  });
  assert.equal(stateOf(rows, 'address'), 'done');
  assert.equal(stateOf(rows, 'key'), 'done');
});

test('every failure the client can produce lands on a real condition', () => {
  const failures = [
    { kind: 'invalid_request', mutationOutcome: 'not_dispatched', message: 'x', path: [] },
    { kind: 'cancelled', mutationOutcome: 'not_dispatched', message: 'x' },
    { kind: 'unsupported_fetch', mutationOutcome: 'not_dispatched', message: 'x' },
    {
      kind: 'invalid_response',
      reason: 'redirect_refused',
      mutationOutcome: 'not_applicable',
      message: 'x',
    },
  ];
  for (const failure of failures) {
    const { step } = describeVerifyFailure(failure);
    assert.ok(HANDSHAKE_STEPS.includes(step), `${failure.kind} -> ${step}`);
  }
});

test('a verified connection shows all five, with nothing outstanding', () => {
  const rows = view({ phase: { kind: 'connected' } });
  assert.equal(rows.length, HANDSHAKE_STEPS.length);
  assert.ok(rows.every((row) => row.state === 'done'));
  assert.ok(rows.every((row) => row.problem === undefined));
});

test('no row is ever shown as pending after a failure', () => {
  const problem = describeVerifyFailure({
    kind: 'api_error',
    status: 401,
    mutationOutcome: 'rejected',
    message: 'x',
    error: { code: 'unauthorized', kind: 'client' },
    details: {},
  });
  const rows = view({ phase: { kind: 'failed', problem } });
  assert.ok(rows.every((row) => row.state !== 'pending'));
});
