import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { API_ERROR_CODES } from '@raphael/contracts';

import { ConnectionError, connectFrom, timeoutFrom } from '../src/modules/connection/remote.ts';
import { EXIT_CODES, SERVER_CODE_EXIT, categoryOf } from '../src/shared/exit.ts';

/**
 * The exit-code table is a contract: agents branch on it. These pin it as ADR 0009 and the plan's
 * decision 10 state it, so changing a meaning is a deliberate edit here too.
 */

describe('the exit-code table', () => {
  it('has the agreed codes, in order, each with one category', () => {
    assert.deepEqual(
      EXIT_CODES.map(({ code, category }) => [code, category]),
      [
        [0, 'ok'],
        [1, 'failed'],
        [2, 'usage'],
        [3, 'not_found'],
        [4, 'conflict'],
        [5, 'not_configured'],
        [6, 'retryable'],
        [7, 'outcome_unknown'],
        [130, 'interrupted'],
        [143, 'interrupted'],
      ],
    );
    assert.equal(categoryOf(7), 'outcome_unknown');
  });

  it('maps every server code, by what the caller should do next', () => {
    assert.deepEqual(Object.keys(SERVER_CODE_EXIT).sort(), [...API_ERROR_CODES].sort());
    assert.deepEqual(SERVER_CODE_EXIT, {
      invalid_input: 2,
      payload_too_large: 2,
      unsupported_media_type: 2,
      unsupported_content: 2,
      node_not_found: 3,
      slug_conflict: 4,
      revision_conflict: 4,
      node_archived: 4,
      invalid_parent: 4,
      unauthorized: 5,
      route_not_found: 5,
      method_not_allowed: 5,
      storage_busy: 6,
      // Never "retryable": a write the server could not complete may have been applied.
      internal_error: 'server_fault',
    });
  });
});

describe('RAPHAEL_TIMEOUT', () => {
  it('is whole seconds, from 1 to 120, and unset or empty means the default', () => {
    assert.equal(timeoutFrom({}), undefined);
    assert.equal(timeoutFrom({ RAPHAEL_TIMEOUT: '' }), undefined);
    assert.equal(timeoutFrom({ RAPHAEL_TIMEOUT: '1' }), 1_000);
    assert.equal(timeoutFrom({ RAPHAEL_TIMEOUT: '120' }), 120_000);
    for (const value of ['0', '121', '1.5', '-3', '10s', ' 5', '1e2']) {
      assert.throws(
        () => timeoutFrom({ RAPHAEL_TIMEOUT: value }),
        (error: unknown) =>
          error instanceof ConnectionError && error.reason === 'timeout_out_of_range',
        value,
      );
    }
  });

  it('bounds the transport a remote command uses', () => {
    const transport = connectFrom(
      {
        RAPHAEL_ENDPOINT: 'http://127.0.0.1:9',
        RAPHAEL_API_KEY: 'timeout-key-0123456789abcdef0123456789',
        RAPHAEL_TIMEOUT: '42',
      },
      process.platform,
    );
    assert.equal(transport.timeoutMs, 42_000);
  });
});
