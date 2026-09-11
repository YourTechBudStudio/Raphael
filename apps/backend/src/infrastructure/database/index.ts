export {
  DatabaseUnavailableError,
  openDatabase,
  type DatabaseConnection,
  type DatabaseOptions,
} from './connection.ts';
export {
  MigrationHistoryError,
  MIGRATIONS_TABLE,
  inspectMigrationHistory,
  readBundledMigrations,
  type BundledMigration,
  type MigrationState,
} from './guard.ts';
export { Db, layer, type DatabaseLayerOptions, type DatabaseService } from './layer.ts';
export { migrateToLatest, migrationsFolder } from './migrate.ts';
export {
  DatabaseLocationError,
  SIDECAR_SUFFIXES,
  prepareDataDirectory,
  prepareDatabaseFile,
  supportsPosixModes,
  verifySidecars,
} from './location.ts';
