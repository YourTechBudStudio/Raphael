import { dirname, isAbsolute, resolve } from 'node:path';

import { Either, ParseResult, Schema } from 'effect';

import { configurationFailure } from './errors.ts';

/**
 * The configuration surface, its bounds, and its defaults.
 *
 * Every non-secret option has a default, so a server starts with no file at all and a file only ever
 * states a deliberate departure. Every option is bounded: an unbounded integer here becomes an
 * unbounded timer, an unbounded batch, or an unbounded wait later, and a mistyped number should be
 * refused at startup rather than discovered as strange runtime behavior.
 *
 * There is no secret field. `RAPHAEL_API_KEY` is the only credential input and it never appears in
 * this file's vocabulary, so a configuration file committed to a repository cannot carry one.
 *
 * The result is deliberately *not* the shape of the file. `databasePath` is resolved to an absolute
 * path here, because resolution depends on where the file was found - relative to the configuration
 * file's directory, or to the invocation directory when there is no file - and no later consumer
 * should have to know which case it was.
 */

const boundedInteger = (name: string, min: number, max: number) =>
  Schema.Int.pipe(
    Schema.between(min, max, {
      message: () => `${name} must be a whole number between ${min} and ${max}`,
    }),
  );

/**
 * Control and format characters are never part of a real address or path, and a value carrying one is
 * either a copy-paste accident or an attempt to make a diagnostic print something it should not.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u;

/** A host is an address to bind, not a URL. */
const Host = Schema.String.pipe(
  Schema.filter((value) =>
    value.length > 0 && value.length <= 255 && !UNPRINTABLE.test(value)
      ? true
      : 'host must be a non-empty address with no spaces or control characters',
  ),
);

const DatabasePath = Schema.String.pipe(
  Schema.filter((value) =>
    value.trim().length > 0 && value.length <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(value)
      ? true
      : 'database path must be a non-empty path with no control characters',
  ),
);

/**
 * Port 0 asks the operating system for an arbitrary free port. That is useful to a test that then
 * reads the bound address back, and useless to an operator whose clients need a fixed address - so it
 * is rejected here and permitted only through the programmatic interface.
 */
const ConfiguredPort = boundedInteger('port', 1, 65_535);

const FileShape = Schema.Struct({
  server: Schema.optional(
    Schema.Struct({
      host: Schema.optional(Host),
      port: Schema.optional(ConfiguredPort),
    }),
  ),
  database: Schema.optional(
    Schema.Struct({
      path: Schema.optional(DatabasePath),
      busyTimeoutMs: Schema.optional(boundedInteger('busyTimeoutMs', 0, 60_000)),
    }),
  ),
  idempotency: Schema.optional(
    Schema.Struct({
      gcIntervalMinutes: Schema.optional(boundedInteger('gcIntervalMinutes', 1, 1_440)),
      /**
       * The batch bound is validated as a positive integer here and nowhere else has to re-check it.
       * That matters more than it looks: SQLite treats a negative `LIMIT` as *no limit*, so a batch
       * size that reached the delete statement unvalidated would turn a bounded sweep into an
       * unbounded one.
       */
      gcBatchSize: Schema.optional(boundedInteger('gcBatchSize', 1, 10_000)),
    }),
  ),
});

export const CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  databasePath: './data/raphael.sqlite',
  busyTimeoutMs: 5_000,
  gcIntervalMinutes: 60,
  gcBatchSize: 500,
} as const;

export interface ServerOptions {
  readonly host: string;
  /** 0 only through the programmatic interface; a configuration file cannot ask for one. */
  readonly port: number;
}

export interface DatabaseSettings {
  /** Already absolute. Resolved against the configuration file's directory, or the invocation directory. */
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
}

export interface IdempotencySettings {
  readonly gcIntervalMinutes: number;
  readonly gcBatchSize: number;
}

/** Validated, defaulted, non-secret options. Holds no credential and is safe to inspect. */
export interface BackendOptions {
  readonly server: ServerOptions;
  readonly database: DatabaseSettings;
  readonly idempotency: IdempotencySettings;
}

const decodeFileShape = Schema.decodeUnknownEither(FileShape, {
  // Unknown fields are refused. A misspelled option that is silently ignored is a server running with
  // settings its operator believes they changed.
  onExcessProperty: 'error',
  errors: 'all',
});

/**
 * Apply bounds and defaults to a parsed configuration value.
 *
 * `baseDirectory` is where a relative database path resolves from: the configuration file's own
 * directory when there is a file, the invocation directory when there is not. `label` names the source
 * in a diagnostic, so an operator knows whether to edit a file or their command.
 */
export const resolveOptions = (
  value: unknown,
  context: { readonly baseDirectory: string; readonly label: string },
): BackendOptions => {
  const decoded = decodeFileShape(value ?? {});
  if (Either.isLeft(decoded)) {
    // Every issue is reported, not just the first, so an operator fixes one file rather than
    // restarting once per mistake. Paths are option names; the values are the operator's own.
    const described = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    configurationFailure('config_invalid', `${context.label} is not valid. ${described}`);
  }

  const file = decoded.right;
  const databasePath = file.database?.path ?? CONFIG_DEFAULTS.databasePath;
  return {
    server: {
      host: file.server?.host ?? CONFIG_DEFAULTS.host,
      port: file.server?.port ?? CONFIG_DEFAULTS.port,
    },
    database: {
      databasePath: isAbsolute(databasePath)
        ? resolve(databasePath)
        : resolve(context.baseDirectory, databasePath),
      busyTimeoutMs: file.database?.busyTimeoutMs ?? CONFIG_DEFAULTS.busyTimeoutMs,
    },
    idempotency: {
      gcIntervalMinutes: file.idempotency?.gcIntervalMinutes ?? CONFIG_DEFAULTS.gcIntervalMinutes,
      gcBatchSize: file.idempotency?.gcBatchSize ?? CONFIG_DEFAULTS.gcBatchSize,
    },
  };
};

/**
 * Re-check already-resolved options at a programmatic boundary, and return a snapshot of what was
 * checked.
 *
 * `serve` is importable, so "the YAML loader validated it" is only true of options that came through
 * the YAML loader. A caller can construct a `BackendOptions` literal directly - the type is an
 * ordinary structure of `number` and `string` - and a value like `gcBatchSize: -1` would then reach
 * the delete statement, where SQLite reads a negative `LIMIT` as *no limit* and one batch becomes the
 * whole backlog in a single transaction. Bounds that hold for a file and not for a caller are not
 * bounds.
 *
 * **Returning the caller's object would leave the check decorative.** Startup is asynchronous, and the
 * batch size is not read until after the listener has been acquired, so an object that was valid when
 * it was inspected can be a different object by the time it is used - by ordinary mutation, or by an
 * accessor that answers differently the second time it is asked. Both were measured against an earlier
 * version of this function, and both put `-1` back into the delete statement. So every value is read
 * **once**, into a local, and the result is a fresh structure built from what was actually validated.
 * Nothing the caller still holds a reference to survives into the server. This is the same discipline
 * the creation pipeline already applies to request fields.
 *
 * The bounds themselves are not restated here: this decodes against the same schema, so there is one
 * definition and it cannot drift. The single deliberate difference is the port. A configuration file
 * may not ask for an arbitrary port because an operator's clients need a fixed address; a programmatic
 * caller may, because it can read the bound address back - which is what finite integration tests do.
 */
export const validateOptions = (options: BackendOptions): BackendOptions => {
  // Every value is read exactly once, here. After this line nothing touches the caller's object, so a
  // getter cannot be asked twice and an assignment afterwards has nothing left to reach.
  const supplied = {
    host: options.server.host,
    port: options.server.port,
    databasePath: options.database.databasePath,
    busyTimeoutMs: options.database.busyTimeoutMs,
    gcIntervalMinutes: options.idempotency.gcIntervalMinutes,
    gcBatchSize: options.idempotency.gcBatchSize,
  };

  const ephemeralPort = supplied.port === 0;
  const decoded = decodeFileShape({
    server: { host: supplied.host, ...(ephemeralPort ? {} : { port: supplied.port }) },
    database: { path: supplied.databasePath, busyTimeoutMs: supplied.busyTimeoutMs },
    idempotency: {
      gcIntervalMinutes: supplied.gcIntervalMinutes,
      gcBatchSize: supplied.gcBatchSize,
    },
  });
  if (Either.isLeft(decoded)) {
    const described = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    configurationFailure(
      'config_invalid',
      `the supplied server options are not valid. ${described}`,
    );
  }
  if (!Number.isSafeInteger(supplied.port) || supplied.port < 0) {
    configurationFailure(
      'config_invalid',
      'the supplied server options are not valid. server.port must be 0 or a whole number between 1 and 65535',
    );
  }
  if (!isAbsolute(supplied.databasePath)) {
    configurationFailure(
      'config_invalid',
      'the supplied server options are not valid. database.path must already be resolved to an absolute path',
    );
  }

  // Built from the decoder's output rather than from `supplied`, so that if a bound ever becomes a
  // transform the server uses the transformed value. Every field is optional in the file schema and
  // every one was passed above, so each fallback is unreachable today and exists to satisfy the type;
  // the port fallback is the one real case, because an ephemeral port is deliberately not decoded.
  const checked = decoded.right;
  return {
    server: {
      host: checked.server?.host ?? supplied.host,
      port: ephemeralPort ? 0 : (checked.server?.port ?? supplied.port),
    },
    database: {
      databasePath: checked.database?.path ?? supplied.databasePath,
      busyTimeoutMs: checked.database?.busyTimeoutMs ?? supplied.busyTimeoutMs,
    },
    idempotency: {
      gcIntervalMinutes: checked.idempotency?.gcIntervalMinutes ?? supplied.gcIntervalMinutes,
      gcBatchSize: checked.idempotency?.gcBatchSize ?? supplied.gcBatchSize,
    },
  };
};

/** The directory a relative database path resolves against, given where the configuration came from. */
export const baseDirectoryFor = (configPath: string | undefined, cwd: string): string =>
  configPath === undefined ? resolve(cwd) : dirname(resolve(configPath));
