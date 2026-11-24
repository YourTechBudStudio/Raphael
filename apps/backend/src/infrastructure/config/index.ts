import { resolveCredential, type ApiCredential } from './credential.ts';
import { API_KEY_VARIABLE, loadEnvironment } from './env.ts';
import {
  baseDirectoryFor,
  checkOverrides,
  resolveOptions,
  type BackendOptions,
  type OptionOverrides,
} from './options.ts';
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
 * Order is load-bearing. Flag values are checked first, then the configuration file is read, then the
 * credential is resolved - all before any port is bound or database opened, so every one of these
 * fails while there is nothing to unwind. The file comes before the key because the key is looked
 * for beside it: a mistyped `--config` must be reported as itself, not as a missing key.
 *
 * Database infrastructure below this stays environment-blind. It receives values; it does not look
 * anything up.
 */

export interface LoadedConfiguration {
  readonly options: BackendOptions;
  readonly credential: ApiCredential;
  /** Where the key came from, for the startup summary. Never the key. */
  readonly keySource: {
    readonly variable: string;
    readonly file: string | undefined;
    /** The file's value had an unquoted `#`, so the key stops before it (the dotenv convention). */
    readonly cutAtComment: boolean;
  };
}

export interface LoadConfigurationContext {
  /** An explicitly supplied YAML path. Absent means defaults, not a search for a file. */
  readonly configPath?: string;
  /**
   * The invocation directory. `.env` is looked for here only when there is no configuration file;
   * with one, it is looked for beside that file, so the two that configure one server sit together.
   */
  readonly cwd?: string;
  /** Values from `server serve` flags, which win over the file. */
  readonly overrides?: OptionOverrides;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly readEnvFile?: boolean;
}

export const loadConfiguration = (context: LoadConfigurationContext = {}): LoadedConfiguration => {
  const cwd = context.cwd ?? process.cwd();
  const { configPath } = context;
  // A mistyped flag, then a configuration file that cannot be read, before the key: the key is looked
  // for beside that file, so a wrong --config would otherwise read as a missing key.
  checkOverrides({ ...context.overrides, ...(configPath === undefined ? {} : { configPath }) });
  const parsed = configPath === undefined ? undefined : readConfigFile(configPath);
  const baseDirectory = baseDirectoryFor(configPath, cwd);
  const environment = loadEnvironment({
    directory: baseDirectory,
    ...(context.processEnv === undefined ? {} : { processEnv: context.processEnv }),
    ...(context.readEnvFile === undefined ? {} : { readEnvFile: context.readEnvFile }),
  });
  const credential = resolveCredential(environment);

  const options = resolveOptions(parsed, {
    baseDirectory,
    label: configPath === undefined ? 'the default configuration' : `"${configPath}"`,
    ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    overrideDirectory: cwd,
  });

  return {
    options,
    credential,
    keySource: {
      variable: API_KEY_VARIABLE,
      file: environment.sourceOf(API_KEY_VARIABLE) === 'file' ? environment.envFile : undefined,
      cutAtComment: environment.cutAtComment(API_KEY_VARIABLE),
    },
  };
};

export { ApiCredential, resolveCredential } from './credential.ts';
export {
  API_KEY_VARIABLE,
  CLIENT_API_KEY_VARIABLE,
  ENV_FILE_NAME,
  ENV_MAX_BYTES,
  loadEnvironment,
  type EnvironmentSnapshot,
} from './env.ts';
export { ConfigurationError, type ConfigurationReason } from './errors.ts';
export {
  CONFIG_DEFAULTS,
  CONFIGURED_PORT_RANGE,
  type OptionOverrides,
  baseDirectoryFor,
  resolveOptions,
  validateOptions,
  type BackendOptions,
  type DatabaseSettings,
  type ServerOptions,
} from './options.ts';
export { CONFIG_MAX_BYTES, readConfigFile } from './yaml.ts';
