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

const OPERATIONS = [
  'createNode',
  'getNode',
  'getNodePath',
  'listNodes',
  'searchNodes',
  'updateNode',
] as const;

const ERROR_CONTRACT = [
  'IdempotencyConflict',
  'InternalFailure',
  'InvalidInput',
  'InvalidParent',
  'NodeNotFound',
  'RevisionConflict',
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

/** Phase 05: starting a server, and working out what to start it with. */
const RUNTIME = [
  'ApiCredential',
  'CONFIG_DEFAULTS',
  'ConfigurationError',
  'DEFAULT_DEADLINES',
  'consoleLogger',
  'loadConfiguration',
  'resolveOptions',
  'serve',
  'silentLogger',
  'validateOptions',
] as const;

test('the nodes capability publishes its operations and its error contract, and no storage detail', () => {
  assert.deepEqual([...Object.keys(capability)].sort(), [...OPERATIONS, ...ERROR_CONTRACT].sort());
});

test('the package root adds composition and runtime primitives, and still no storage detail', () => {
  assert.deepEqual(
    [...Object.keys(packageRoot)].sort(),
    [...OPERATIONS, ...ERROR_CONTRACT, ...COMPOSITION, ...RUNTIME].sort(),
  );
});
