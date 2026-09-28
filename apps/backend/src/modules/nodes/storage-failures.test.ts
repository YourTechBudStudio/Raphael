import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFailure } from './storage-failures.ts';

/** A driver error as better-sqlite3 actually shapes one. */
const sqliteError = (code: string, message: string): Error => {
  const error = new Error(message);
  error.name = 'SqliteError';
  (error as Error & { code: string }).code = code;
  return error;
};

const context = { operation: 'nodes.create', stage: 'write', slug: 'quarterly-plan' } as const;

test('the two measured slug violations are the only ones recognized', () => {
  const sibling = classifyFailure(
    context,
    sqliteError(
      'SQLITE_CONSTRAINT_UNIQUE',
      'UNIQUE constraint failed: nodes.parent_id, nodes.slug',
    ),
  );
  assert.equal(sibling._tag, 'SlugConflict');
  assert.deepEqual(
    { slug: (sibling as { slug: string }).slug, scope: (sibling as { scope: string }).scope },
    { slug: 'quarterly-plan', scope: 'sibling' },
  );

  const root = classifyFailure(
    context,
    sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: nodes.slug'),
  );
  assert.equal(root._tag, 'SlugConflict');
  assert.equal((root as { scope: string }).scope, 'root');
});

test('other uniqueness failures are internal, including a primary key', () => {
  // A primary-key collision is PRIMARYKEY rather than UNIQUE, with the same message prefix. It is not
  // a slug conflict, so it must not tell the caller to rename something.
  const primary = classifyFailure(
    context,
    sqliteError('SQLITE_CONSTRAINT_PRIMARYKEY', 'UNIQUE constraint failed: favorites.node_id'),
  );
  assert.equal(primary._tag, 'InternalFailure');

  const identity = classifyFailure(
    context,
    sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: nodes.id, nodes.type'),
  );
  assert.equal(identity._tag, 'InternalFailure');

  // A reworded diagnostic must fail safe rather than be guessed at.
  const reworded = classifyFailure(
    context,
    sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed on nodes(parent_id, slug)'),
  );
  assert.equal(reworded._tag, 'InternalFailure');
});

test('a foreign-key violation is never attributed to the caller', () => {
  // SQLite reports no constraint or column here, so a missing parent and a mistyped one are the same
  // error. Parentage is validated before the insert precisely because this evidence cannot decide it.
  const failure = classifyFailure(
    context,
    sqliteError('SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'),
  );
  assert.equal(failure._tag, 'InternalFailure');
});

test('busy is an internal failure: the exclusive lock leaves no one to wait for', () => {
  const failure = classifyFailure(context, sqliteError('SQLITE_BUSY', 'database is locked'));
  assert.equal(failure._tag, 'InternalFailure');
});

test('only the driver error itself is matched, never a wrapper message', () => {
  const misleading = new Error('UNIQUE constraint failed: nodes.slug -- params: secret');
  assert.equal(classifyFailure(context, misleading)._tag, 'InternalFailure');
});

test('a slug conflict needs a slug to name, and is internal without one', () => {
  const failure = classifyFailure(
    { operation: 'nodes.create', stage: 'write' },
    sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: nodes.slug'),
  );
  assert.equal(failure._tag, 'InternalFailure');
});

test('an exception that is not a driver error keeps its cause and stays internal', () => {
  const cause = new TypeError('something else entirely');
  const failure = classifyFailure(context, cause);
  assert.equal(failure._tag, 'InternalFailure');
  assert.equal(
    (failure as { cause?: unknown }).cause,
    cause,
    'the evidence is retained for the operator',
  );
});

test('a failure with no SQLite code is not diagnosed as a storage failure', () => {
  // The presence of a result code, not the block the exception came from, is what makes something a
  // storage failure. A parser fault during conversion must not be reported as a rejected query.
  const parserFault = classifyFailure(
    { operation: 'nodes.create', stage: 'content conversion' },
    new RangeError('Maximum call stack size exceeded'),
  );
  assert.equal(parserFault._tag, 'InternalFailure');
  const detail = (parserFault as { detail: string }).detail;
  assert.equal(detail, 'the content conversion stage failed unexpectedly');
  assert.equal(detail.includes('storage'), false, 'the diagnostic must not misname the subsystem');
});

test('a storage failure names the stage it interrupted', () => {
  const failure = classifyFailure(
    { operation: 'nodes.get', stage: 'read' },
    sqliteError('SQLITE_CORRUPT', 'database disk image is malformed'),
  );
  assert.equal(failure._tag, 'InternalFailure');
  assert.equal(
    (failure as { detail: string }).detail,
    'storage rejected the read stage with SQLITE_CORRUPT',
  );
});
