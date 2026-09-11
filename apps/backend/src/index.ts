/**
 * Backend composition surface. The database infrastructure accepts validated options; it never reads
 * configuration or environment itself. Operational YAML and environment composition arrive in phase 05.
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
export { creationReplays, nodes } from './modules/nodes/index.ts';
