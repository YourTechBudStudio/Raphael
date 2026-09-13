/**
 * What the setup screen is allowed to say, and when.
 *
 * The rules themselves are not here. `parseEndpoint` and `hasApiKey` come from the shared packages,
 * so an address the CLI would refuse to save is an address this screen refuses to send. What is
 * here is the mapping from those outcomes to sentences that make sense to someone holding a phone.
 *
 * Plain HTTP is accepted to any host, which is the owner's decision recorded in the client's
 * endpoint module. This screen does not second-guess it with a warning of its own.
 *
 * Every switch is exhaustive on purpose. A new failure reason in the client should break this file
 * at compile time rather than reaching a person as a blank box or a generic apology.
 *
 * Nothing here imports from `react-native`, so the whole mapping runs under `node --test`.
 */

import {
  isEndpointRejection,
  parseEndpoint,
  type ClientFailure,
  type InvalidResponseReason,
} from '@raphael/client';
import { hasApiKey } from '@raphael/contracts/connection';

/**
 * The five conditions that must hold, in the order they are established.
 *
 * The order is causal, not cosmetic. It is what lets a failure say how far it got: a refused key
 * proves the first three, and a timeout proves only the first two. Collapsing these into one error
 * box throws that away and leaves every failure looking like "it did not work".
 *
 * The first two are decided locally, as you type. The last three need the network, and none of
 * them exists on screen until there is something true to say about it.
 */
export const HANDSHAKE_STEPS = ['address', 'key', 'reachable', 'accepted', 'version'] as const;

export type HandshakeStep = (typeof HANDSHAKE_STEPS)[number];

/** Checked here, before anything is sent. */
export const LOCAL_STEPS = 2;

export const STEP_LABELS: Readonly<Record<HandshakeStep, string>> = {
  address: 'The address looks right',
  key: 'The key is the right shape',
  reachable: 'The server answers',
  accepted: 'The key is accepted',
  version: 'The versions match',
};

/** A problem, and the exact condition it broke. */
export interface SetupProblem {
  readonly step: HandshakeStep;
  readonly title: string;
  readonly detail: string;
}

export interface FieldProblems {
  readonly endpoint?: string;
  readonly key?: string;
}

/**
 * Everything checkable before anything is sent.
 *
 * Both fields are always reported, never just the first: someone who mistyped the address and
 * pasted a truncated key should learn both facts in one press rather than two.
 */
export const inspectSetupInput = (endpointInput: string, keyInput: string): FieldProblems => {
  const problems: { endpoint?: string; key?: string } = {};

  const trimmed = endpointInput.trim();
  if (trimmed === '') {
    problems.endpoint = 'Enter the address your server answers on.';
  } else {
    const endpoint = parseEndpoint(trimmed);
    if (isEndpointRejection(endpoint)) problems.endpoint = endpoint.message;
  }

  // Whatever the owner configured their server with is a valid key. The only thing missing here
  // is a key at all.
  if (!hasApiKey(keyInput)) {
    problems.key = 'Paste the API key your server was started with.';
  }

  return problems;
};

export const hasFieldProblem = (problems: FieldProblems): boolean =>
  problems.endpoint !== undefined || problems.key !== undefined;

/**
 * A verification failure, in words, and where it stopped.
 *
 * The hard case is `transport`. React Native's fetch reports a server that is not running and a
 * connection dropped mid-exchange as the same opaque error, so this must not guess between them -
 * see the note in the client's `failure.ts`. It names the possibilities instead of picking one.
 */
export const describeVerifyFailure = (failure: ClientFailure): SetupProblem => {
  switch (failure.kind) {
    case 'invalid_request':
      return {
        step: 'address',
        title: 'Raphael could not make that request.',
        detail: failure.message,
      };
    case 'timeout':
      return {
        step: 'reachable',
        title: 'The server did not answer in time.',
        detail: 'It may still be starting up, or busy. Nothing was saved, so trying again is safe.',
      };
    case 'cancelled':
      return { step: 'reachable', title: 'Verification stopped.', detail: 'Nothing was saved.' };
    case 'transport':
      return {
        step: 'reachable',
        title: 'Could not reach that address.',
        detail:
          'From here, a server that is not running looks exactly like a wrong address or a network ' +
          'that cannot get there. Check all three.',
      };
    case 'unsupported_fetch':
      return {
        step: 'reachable',
        title: 'This device cannot make that request.',
        detail: failure.message,
      };
    case 'api_error':
      return describeApiError(failure.status, failure.message);
    case 'invalid_response':
      return describeInvalidResponse(failure.reason, failure.message);
  }
};

const describeApiError = (status: number, message: string): SetupProblem => {
  if (status === 401 || status === 403) {
    return {
      step: 'accepted',
      title: 'That key was refused.',
      detail: 'The server is there and answering. It just does not accept this key.',
    };
  }
  return { step: 'accepted', title: 'The server refused the check.', detail: message };
};

const describeInvalidResponse = (reason: InvalidResponseReason, message: string): SetupProblem => {
  switch (reason) {
    case 'incompatible_protocol':
      return { step: 'version', title: 'A different version of Raphael.', detail: message };
    case 'redirect_refused':
      return {
        step: 'reachable',
        title: 'That address redirects somewhere else.',
        detail:
          'Raphael will not follow a redirect while carrying your key, because it would hand the ' +
          'key to wherever the redirect points. Use the address the server answers on directly.',
      };
    case 'response_too_large':
      return {
        step: 'reachable',
        title: 'The answer was too large to read.',
        detail: 'Something other than Raphael is probably answering on that address.',
      };
    case 'unexpected_status':
    case 'empty_response':
    case 'invalid_utf8':
    case 'malformed_json':
    case 'invalid_payload':
    case 'inconsistent_error':
    case 'unrecognized_error':
      return {
        step: 'reachable',
        title: 'Something answered, but not Raphael.',
        detail:
          'A router, a proxy, or another service is on that address. Check the port, and any path ' +
          'the server is served under.',
      };
  }
};

/* -------------------------------------------------------------------------- the handshake view */

export type StepState = 'pending' | 'running' | 'done' | 'failed';

export type SetupPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'failed'; readonly problem: SetupProblem }
  | { readonly kind: 'connected' };

export interface HandshakeRow {
  readonly step: HandshakeStep;
  readonly label: string;
  readonly state: StepState;
  /** Set on the failed row only, so the explanation sits against the condition it broke. */
  readonly problem?: SetupProblem;
}

export interface HandshakeInput {
  readonly endpoint: string;
  readonly key: string;
  /**
   * Fields the person has left. A field they are still in stays quiet: turning a row red while
   * someone is typing the "h" of "https" accuses them of a mistake they are two keystrokes away
   * from not making.
   */
  readonly settled: { readonly endpoint: boolean; readonly key: boolean };
  /**
   * Whether Connect has been pressed on the current values.
   *
   * This is what makes an *empty* field speak. Leaving a field blank is unfinished, not wrong, so
   * blurring past it says nothing - but pressing Connect is someone declaring they are done, and a
   * button that appears to do nothing because a field is empty is worse than being told.
   */
  readonly attempted: boolean;
  readonly phase: SetupPhase;
}

/**
 * The conditions this attempt has actually established, and only those.
 *
 * A row appears when there is something true to say about it. The two local checks are always
 * present because typing settles them immediately; the three network ones arrive as they resolve.
 * Nothing is ever shown as `pending` after a failure - a refused key says nothing about the
 * server's protocol version, because we never got to ask, and a greyed-out row implying otherwise
 * is a claim we cannot support.
 *
 * This is also why the list is not a gate. It reports, it does not authorize; Connect is pressable
 * whatever it says.
 */
export const handshakeRows = (input: HandshakeInput): readonly HandshakeRow[] => {
  const { phase } = input;
  const rows: HandshakeRow[] = [...localRows(input)];

  if (phase.kind === 'idle') return rows;

  // Anything past the local pair means both passed, whatever they were showing a moment ago.
  // Rebuilt rather than spread, so a stale reason cannot ride along on a row that now succeeds.
  const settledLocal = rows.map((existing) => row(existing.step, 'done'));

  if (phase.kind === 'verifying') {
    return [...settledLocal, row('reachable', 'running')];
  }

  if (phase.kind === 'connected') {
    return [
      ...settledLocal,
      row('reachable', 'done'),
      row('accepted', 'done'),
      row('version', 'done'),
    ];
  }

  const failedAt = HANDSHAKE_STEPS.indexOf(phase.problem.step);
  if (failedAt < LOCAL_STEPS) {
    return rows.map((existing) =>
      existing.step === phase.problem.step
        ? { ...row(existing.step, 'failed'), problem: phase.problem }
        : row(existing.step, 'done'),
    );
  }

  const reached = HANDSHAKE_STEPS.slice(LOCAL_STEPS, failedAt).map((step) => row(step, 'done'));
  return [
    ...settledLocal,
    ...reached,
    { ...row(phase.problem.step, 'failed'), problem: phase.problem },
  ];
};

const row = (step: HandshakeStep, state: StepState): HandshakeRow => ({
  step,
  label: STEP_LABELS[step],
  state,
});

/**
 * The two local conditions, judged as you type.
 *
 * Valid is green immediately: that is the whole point of checking locally. Invalid speaks once the
 * person is done with the field - they left it, or they pressed Connect - and never before.
 *
 * Each row carries its own reason rather than the first one found, because both fields can be
 * wrong at once and the person should learn both in one go.
 */
const localRows = (input: HandshakeInput): readonly HandshakeRow[] => {
  const problems = inspectSetupInput(input.endpoint, input.key);

  return LOCAL_FIELDS.map(({ step, field, filled, title }) => {
    const detail = problems[field];
    if (detail === undefined) return row(step, 'done');

    // An empty field is unfinished rather than wrong, so only a deliberate attempt makes it speak.
    const done = input.attempted || (input.settled[field] && filled(input));
    if (!done) return row(step, 'pending');

    return { ...row(step, 'failed'), problem: { step, title, detail } };
  });
};

const LOCAL_FIELDS = [
  {
    step: 'address',
    field: 'endpoint',
    title: 'The address is missing or unusable.',
    filled: (input: HandshakeInput) => input.endpoint.trim() !== '',
  },
  {
    step: 'key',
    field: 'key',
    title: 'No key yet.',
    filled: (input: HandshakeInput) => input.key !== '',
  },
] as const satisfies readonly {
  step: HandshakeStep;
  field: 'endpoint' | 'key';
  title: string;
  filled: (input: HandshakeInput) => boolean;
}[];
