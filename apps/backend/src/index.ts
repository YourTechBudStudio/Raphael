/**
 * Backend composition surface.
 *
 * The database infrastructure accepts validated options; it never reads configuration or environment
 * itself. The node operations take undecoded requests and return Effects requiring only `Db`, so the
 * runtime that composes them owns transport, authentication, and configuration - and owns none of the
 * hierarchy rules. Operational YAML and environment composition arrive in phase 05.
 *
 * Table declarations are deliberately absent. `Db` has to be public for composition, so publishing the
 * canonical tables beside it would hand a future runtime or extension everything needed to write past
 * the validation, parentage, replay, and integrity rules these operations exist to enforce. Schema
 * access is an internal path, used by migration tooling and by the tests that assert storage behavior.
 */
export {
  DatabaseLocationError,
  DatabaseUnavailableError,
  Db,
  MigrationHistoryError,
  layer,
  migrationsFolder,
  openDatabase,
  type DatabaseConnection,
  type DatabaseLayerOptions,
  type DatabaseOptions,
  type DatabaseService,
  type MigrationState,
} from './infrastructure/database/index.ts';
export {
  IdempotencyConflict,
  InternalFailure,
  InvalidInput,
  InvalidParent,
  NodeNotFound,
  SlugConflict,
  StorageBusy,
  UnsupportedContent,
  createNode,
  getNode,
  getNodePath,
  listNodes,
  toPublicError,
  type InvalidInputReason,
  type NodeError,
  type PublicApiError,
  type RequestField,
  type StoredNodeType,
} from './modules/nodes/index.ts';
