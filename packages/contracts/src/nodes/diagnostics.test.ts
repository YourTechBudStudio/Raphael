import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Either } from 'effect';

import { invalidRequestIssueFrom } from './diagnostics.ts';
import { TITLE_MAX_CODE_POINTS } from './fields.ts';
import { decodeCreateRequest } from './operations.ts';

test('create diagnostics decode the matching type and never quote submitted data', () => {
  for (const type of ['area', 'project', 'resource']) {
    const input = {
      type,
      ...(type === 'resource' ? { kind: 'note' } : {}),
      parent: { path: '/' },
      slug: 'work',
      title: 's'.repeat(TITLE_MAX_CODE_POINTS + 1),
    };
    const decoded = decodeCreateRequest(input);
    assert.ok(Either.isLeft(decoded));
    assert.equal(
      decoded.left.issues.some((issue) => issue.path[0] === 'type'),
      false,
    );
    assert.deepEqual(invalidRequestIssueFrom(decoded.left, input), {
      field: 'title',
      reason: 'title_too_long',
      limit: TITLE_MAX_CODE_POINTS,
    });
  }
});

test('safe diagnostics do not invoke input getters', () => {
  const input = Object.defineProperty({}, 'title', {
    get() {
      throw new Error('must not invoke');
    },
  });
  assert.deepEqual(
    invalidRequestIssueFrom(
      {
        kind: 'invalid_payload',
        message: 'secret',
        issues: [{ path: ['title'], message: 'secret' }],
      },
      input,
    ),
    { field: 'title', reason: 'invalid' },
  );
});
