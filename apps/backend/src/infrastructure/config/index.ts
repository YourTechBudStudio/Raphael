import { resolveCredential, type ApiCredential } from './credential.ts';
import { loadEnvironment } from './env.ts';
import { baseDirectoryFor, resolveOptions, type BackendOptions } from './options.ts';
import { readConfigFile } from './yaml.ts';

/**
 * Configuration loading: a YAML file, an optional `.env`, and the environment, resolved into
 * validated options and a credential.
 *
 * The split in the result is the point. `options` is non-secret, bounded, and safe to inspect or log;
 * `credential` holds only a digest and is never printed. Nothing downstream receives an object
 * containing both a database path and a key, so no later convenience - a debug dump, a diagnostic,
 * an error carrying its context - can leak one by including the other.
 *
 * Order is load-bearing: the credential is resolved *first*, before any file is opened or any port is
 * bound, so the most common misconfiguration fails while there is still nothing to unwind.
 *
 * Database infrastructure below this stays environment-blind. It receives values; it does not look
 * anything up.
 */

export interface LoadedConfiguration {
  readonly options: BackendOptions;
  readonly credential: ApiCredential;
}

export interface LoadConfigurationContext {
  /** An explicitly supplied YAML path. Absent means defaults, not a search for a file. */
  readonly configPath?: string;
  /** The invocation directory: where `.env` is looked for, and what a relative path resolves against. */
  readonly cwd?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly readEnvFile?: boolean;
}

export const loadConfiguration = (context: LoadConfigurationContext = {}): LoadedConfiguration => {
  const cwd = context.cwd ?? process.cwd();
  const environment = loadEnvironment({
    cwd,
    ...(context.processEnv === undefined ? {} : { processEnv: context.processEnv }),
    ...(context.readEnvFile === undefined ? {} : { readEnvFile: context.readEnvFile }),
  });
  const credential = resolveCredential(environment);

  const { configPath } = context;
  const parsed = configPath === undefined ? undefined : readConfigFile(configPath);
  const options = resolveOptions(parsed, {
    baseDirectory: baseDirectoryFor(configPath, cwd),
    label: configPath === undefined ? 'the default configuration' : `"${configPath}"`,
  });

  return { options, credential };
};

export { ApiCredential, resolveCredential } from './credential.ts';
export {
  API_KEY_VARIABLE,
  ENV_FILE_NAME,
  ENV_MAX_BYTES,
  loadEnvironment,
  type EnvironmentSnapshot,
} from './env.ts';
export { ConfigurationError, type ConfigurationReason } from './errors.ts';
export {
  CONFIG_DEFAULTS,
  baseDirectoryFor,
  resolveOptions,
  validateOptions,
  type BackendOptions,
  type DatabaseSettings,
  type IdempotencySettings,
  type ServerOptions,
} from './options.ts';
export { CONFIG_MAX_BYTES, readConfigFile } from './yaml.ts';
