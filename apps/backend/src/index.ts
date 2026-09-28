/**
 * Backend composition surface.
 *
 * Two things are published: the way to start a server, and the way to work out what to start it with.
 * Everything else - the HTTP pipeline, the route table, the database handle -
 * is reached through `serve`, because a caller that could assemble those independently could also
 * assemble them wrongly.
 *
 * `loadConfiguration` and `serve` are deliberately separate. Configuration comes from a file, an
 * environment, and an invocation directory, all of which belong to the process that was invoked; the
 * server takes validated values and looks nothing up. That split is what keeps the database
 * infrastructure environment-blind and lets a caller validate a configuration without starting
 * anything.
 *
 * The node operations stay published for an in-process caller - the SDK path an extension uses - and
 * with them the error contract, which is what makes those operations usable. Table declarations are
 * still absent: `Db` has to be public for composition, and publishing the canonical tables beside it
 * would hand a future runtime everything needed to write past the validation, parentage, and
 * integrity rules these operations exist to enforce.
 *
 * `serve` yields a scoped resource. The caller holds the scope open for as long as the server should
 * run; releasing it performs the documented shutdown. Signal handling and any escalation belong to
 * the process entry point, not here.
 */
export {
  ApiCredential,
  ConfigurationError,
  CONFIG_DEFAULTS,
  loadConfiguration,
  resolveOptions,
  validateOptions,
  type BackendOptions,
  type ConfigurationReason,
  type DatabaseSettings,
  type LoadConfigurationContext,
  type LoadedConfiguration,
  type ServerOptions,
} from './infrastructure/config/index.ts';
export {
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
} from './infrastructure/database/index.ts';
export {
  consoleLogger,
  silentLogger,
  type LogFields,
  type LogLevel,
  type Logger,
} from './infrastructure/http/log.ts';
export {
  InternalFailure,
  InvalidInput,
  InvalidParent,
  NodeArchived,
  NodeNotFound,
  RevisionConflict,
  SlugConflict,
  UnsupportedContent,
  addFavorite,
  archiveNode,
  createNode,
  getNode,
  getNodePath,
  listFavorites,
  listNodes,
  moveNode,
  removeFavorite,
  restoreNode,
  searchNodes,
  toPublicError,
  updateNode,
  type InvalidInputReason,
  type NodeError,
  type PublicApiError,
  type RequestField,
  type NodeType,
  type ResourceKind,
} from './modules/nodes/index.ts';
export { serve, type RunningServer, type ServeConfiguration } from './server.ts';
