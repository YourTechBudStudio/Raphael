import assert from 'node:assert/strict';
import test from 'node:test';

import * as packageRoot from '../src/index.ts';
import * as capability from '../src/modules/nodes/index.ts';

/**
 * What the backend publishes, pinned.
 *
 * A capability is only as deep as its narrowest reachable surface. The database service has to be public
 * so the runtime can compose it, which is exactly why the canonical table declarations must not be:
 * together they would let a future runtime or extension write straight past validation, parentage,
 * replay, and integrity - every rule the operations exist to enforce. Migration tooling reads
 * `schema.ts` by path and storage tests import it directly, so nothing is lost by keeping it internal.
 *
 * These assertions are exhaustive rather than "does not include", so widening the surface is a decision
 * someone makes here on purpose instead of a side effect of adding a re-export.
 */

const OPERATIONS = ['createNode', 'getNode', 'getNodePath', 'listNodes'] as const;

const ERROR_CONTRACT = [
  'IdempotencyConflict',
  'InternalFailure',
  'InvalidInput',
  'InvalidParent',
  'NodeNotFound',
  'SlugConflict',
  'StorageBusy',
  'UnsupportedContent',
  'toPublicError',
] as const;

const COMPOSITION = [
  'DatabaseLocationError',
  'DatabaseUnavailableError',
  'Db',
  'MigrationHistoryError',
  'layer',
  'migrationsFolder',
  'openDatabase',
] as const;

/** Names that must never be reachable from either root. */
const PRIVATE_TO_THE_CAPABILITY = [
  'nodes',
  'creationReplays',
  'MAX_SAFE_DB_INTEGER',
  'REPLAY_TTL_MS',
  'STORED_NODE_TYPES',
] as const;

test('the nodes capability publishes its operations and its error contract, and no storage detail', () => {
  assert.deepEqual([...Object.keys(capability)].sort(), [...OPERATIONS, ...ERROR_CONTRACT].sort());
});

test('the package root adds composition primitives and still no storage detail', () => {
  assert.deepEqual(
    [...Object.keys(packageRoot)].sort(),
    [...OPERATIONS, ...ERROR_CONTRACT, ...COMPOSITION].sort(),
  );
});

test('the canonical tables are not reachable from either root', () => {
  for (const name of PRIVATE_TO_THE_CAPABILITY) {
    assert.equal(name in capability, false, `${name} escaped the capability boundary`);
    assert.equal(name in packageRoot, false, `${name} escaped the package boundary`);
  }
});
