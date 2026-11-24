import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ClientFailure, NetworkCause } from '@raphael/client';
import { API_ERROR_CODES } from '@raphael/contracts';

import { failureFromThrown } from '../src/main.ts';
import { ConfigError, type ConfigReason } from '../src/modules/connection/config.ts';
import { connectionFailure } from '../src/modules/connection/failures.ts';
import { ConnectionError, type ConnectionReason } from '../src/modules/connection/remote.ts';
import { START_FAILED, configurationFailure, startupFailure } from '../src/modules/server/serve.ts';
import { UsageError } from '../src/shared/args.ts';
import { newSession, type Session } from '../src/shared/command.ts';
import { CLI_ERROR_CODES, errorCodeList } from '../src/shared/error-codes.ts';
import { describeClientFailure, type Failure } from '../src/shared/failure.ts';
import { Cancelled, Interrupted, type InterruptSignal } from '../src/shared/interrupt.ts';
import { isUnexplainedAnswer, type Diagnosis } from '../src/shared/server-check.ts';

/**
 * The exit codes the error-code table publishes are the ones the CLI really gives.
 *
 * Every path that chooses an exit code is driven here over the inputs it can meet - each client
 * failure kind, cause, delivery and status, on a read, a write, and the read before a change, with and
 * without what verification can find; each connection and configuration reason; each startup
 * failure; each thrown failure - and the codes and exits that come out are collected. The table must
 * list exactly those, so a change on either side that makes them disagree fails here.
 */

type Seen = Map<string, Set<number>>;

const record = (seen: Seen, failure: Pick<Failure, 'code' | 'exitCode'>): void => {
  const exits = seen.get(failure.code) ?? new Set<number>();
  exits.add(failure.exitCode);
  seen.set(failure.code, exits);
};

const NETWORK_CAUSES: readonly (NetworkCause | undefined)[] = [
  undefined,
  'refused',
  'dns',
  'tls',
  'certificate',
  'reset',
  'unreachable',
  'blocked_port',
  'not_http',
];

/** A code a newer server sends, which this release does not know. */
const NEWER_CODE = 'brand_new';

const STATUSES = [0, 200, 201, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405, 408];
const MORE_STATUSES = [409, 413, 429, 499, 500, 501, 502, 503, 507];

/** Every client failure the transport can report, by kind. */
const clientFailures = (effect: ClientFailure['effect']): ClientFailure[] => {
  const base = { effect, message: 'm' } as const;
  return [
    { ...base, kind: 'invalid_request', delivery: 'not_sent' },
    ...(['not_sent', 'unknown'] as const).map((delivery): ClientFailure => ({
      ...base,
      kind: 'cancelled',
      delivery,
    })),
    ...NETWORK_CAUSES.flatMap((cause) =>
      (['not_sent', 'unknown'] as const).map((delivery): ClientFailure => ({
        ...base,
        kind: 'network',
        delivery,
        ...(cause === undefined ? {} : { cause }),
      })),
    ),
    { ...base, kind: 'timeout', delivery: 'unknown' },
    ...[...STATUSES, ...MORE_STATUSES].flatMap((status): ClientFailure[] => [
      { ...base, kind: 'bad_response', delivery: 'answered', status },
      { ...base, kind: 'http', delivery: 'answered', status },
      ...[...API_ERROR_CODES, NEWER_CODE].map((code): ClientFailure => ({
        ...base,
        kind: 'http',
        delivery: 'answered',
        status,
        code,
      })),
    ]),
    // A protocol mismatch the client found in a verification answer: it carries no status.
    { ...base, kind: 'bad_response', delivery: 'answered', code: 'incompatible_protocol' },
  ];
};

/** What one verification can find, for a failure it is asked about. */
const DIAGNOSES: readonly (Diagnosis | undefined)[] = [
  undefined,
  { kind: 'incompatible', protocolVersion: '2099-01-01', raphaelVersion: '9.0.0' },
  { kind: 'incompatible', protocolVersion: '2020-01-01', raphaelVersion: undefined },
  { kind: 'not_raphael' },
];

const sessionFor = (
  writes: boolean,
  diagnosis: Diagnosis | undefined,
  signal: InterruptSignal | undefined,
): Session => {
  const session = newSession({ command: writes ? 'archive' : 'get', json: true, writes });
  session.endpoint = 'http://127.0.0.1:2';
  session.diagnosis = diagnosis;
  if (signal !== undefined) {
    session.interruption = {
      signal: new AbortController().signal,
      received: () => signal,
      release: () => {},
    };
  }
  return session;
};

const collect = (): Seen => {
  const seen: Seen = new Map();

  for (const effect of ['read', 'write'] as const) {
    for (const failure of clientFailures(effect)) {
      // Verification runs only after an answer it can explain; a cancellation comes from a signal.
      const diagnoses = isUnexplainedAnswer(failure) ? DIAGNOSES : [undefined];
      const signals: readonly (InterruptSignal | undefined)[] =
        failure.kind === 'cancelled' ? ['SIGINT', 'SIGTERM'] : [undefined];
      // A read made before a change, as update, move, archive and restore make one.
      const beforeChange = effect === 'write' ? [false] : [false, true];
      for (const diagnosis of diagnoses) {
        for (const signal of signals) {
          for (const before of beforeChange) {
            const session = sessionFor(effect === 'write' || before, diagnosis, signal);
            record(
              seen,
              describeClientFailure(session, failure, {
                subject: { path: '/work' },
                ...(before ? { beforeChange: true } : {}),
              }),
            );
          }
        }
      }
    }
  }

  const CONFIG_REASONS: Record<ConfigReason, true> = {
    unsupported_platform: true,
    no_home: true,
    relative_xdg_config_home: true,
    relative_home: true,
    directory_unusable: true,
    directory_uncreatable: true,
    file_unusable: true,
    file_unreadable: true,
    file_too_large: true,
    file_malformed: true,
    not_configured: true,
    write_failed: true,
  };
  for (const reason of Object.keys(CONFIG_REASONS) as ConfigReason[]) {
    record(seen, connectionFailure(new ConfigError(reason, 'm')));
  }
  const CONNECTION_REASONS: Record<ConnectionReason, true> = {
    incomplete_environment: true,
    api_key_unsendable: true,
    malformed: true,
    unsupported_scheme: true,
    credentials_in_url: true,
    query_not_allowed: true,
    fragment_not_allowed: true,
    api_key_missing: true,
    timeout_out_of_range: true,
  };
  for (const reason of Object.keys(CONNECTION_REASONS) as ConnectionReason[]) {
    record(seen, connectionFailure(new ConnectionError(reason, 'm')));
  }

  // Thrown past a command, before and after a write was sent.
  for (const writeSent of [false, true]) {
    const session = newSession({ command: 'archive', json: true, writes: true });
    session.writeSent = writeSent;
    for (const thrown of [
      new Interrupted('SIGINT'),
      new Interrupted('SIGTERM'),
      new Cancelled('Cancelled.', 'raphael login'),
      new UsageError('m', 'get'),
      new Error('ours'),
    ]) {
      record(seen, failureFromThrown(thrown, session));
    }
  }

  // Server startup, by stage and by every code the wording distinguishes, and an unknown one.
  const at = {
    host: '127.0.0.1',
    port: 80,
    databasePath: '/srv/raphael.sqlite',
    cause: new Error('m'),
  };
  for (const code of ['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EWHAT']) {
    record(seen, startupFailure({ ...at, stage: 'listen', code }));
  }
  for (const code of [
    'database_in_use',
    'migration_history',
    'foreign_database',
    'migration_failed',
    'EEXIST',
    'ENOENT',
    'EACCES',
    'EISDIR',
    'SQLITE_NOTADB',
    'SQLITE_CORRUPT_INDEX',
    'SQLITE_CANTOPEN',
    'MODULE_NOT_FOUND',
    undefined,
  ]) {
    record(seen, startupFailure({ ...at, stage: 'database', code }));
  }
  record(seen, START_FAILED);
  for (const reason of [
    'config_unreadable',
    'config_too_large',
    'config_malformed',
    'config_unsafe',
    'config_invalid',
    'env_unreadable',
    'env_too_large',
    'api_key_missing',
    'api_key_unsendable',
    'option_invalid',
  ] as const) {
    record(seen, configurationFailure({ reason, message: 'm' }, []));
  }

  return seen;
};

/**
 * Codes some path gives that this test cannot drive in-process, with the exits they come with. Each
 * is pinned by a golden instead: login refuses an address, a missing key or an unsendable key it was
 * given as a usage mistake.
 */
const LOGIN_TYPED: Readonly<Record<string, readonly number[]>> = {
  malformed: [2],
  unsupported_scheme: [2],
  credentials_in_url: [2],
  query_not_allowed: [2],
  fragment_not_allowed: [2],
  api_key_missing: [2],
  api_key_unsendable: [2],
};

describe('published exit codes', () => {
  const seen = collect();
  for (const [code, exits] of Object.entries(LOGIN_TYPED)) {
    for (const exit of exits) record(seen, { code: code as Failure['code'], exitCode: exit as 2 });
  }
  const sorted = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b);

  it('lists exactly the exits each CLI code really comes with', () => {
    const mismatched = Object.entries(CLI_ERROR_CODES).flatMap(([code, entry]) => {
      const actual = sorted(seen.get(code) ?? []);
      const listed = sorted(entry.exits);
      return JSON.stringify(actual) === JSON.stringify(listed)
        ? []
        : [`${code}: listed ${JSON.stringify(listed)}, given ${JSON.stringify(actual)}`];
    });
    assert.deepEqual(mismatched, []);
  });

  it('lists exactly the exits each server code really comes with', () => {
    const listed = new Map(errorCodeList().map((entry) => [entry.code, entry.exitCodes]));
    const mismatched = API_ERROR_CODES.flatMap((code) => {
      const actual = sorted(seen.get(code) ?? []);
      const published = sorted(listed.get(code) ?? []);
      return JSON.stringify(actual) === JSON.stringify(published)
        ? []
        : [`${code}: listed ${JSON.stringify(published)}, given ${JSON.stringify(actual)}`];
    });
    assert.deepEqual(mismatched, []);
  });

  it('gives no code the table does not list', () => {
    const known = new Set<string>([...Object.keys(CLI_ERROR_CODES), ...API_ERROR_CODES]);
    // A newer server's code is passed through as it came, and the table cannot list it.
    assert.deepEqual(
      [...seen.keys()].filter((code) => !known.has(code) && code !== NEWER_CODE),
      [],
    );
  });
});
