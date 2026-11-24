import { isIPv4 } from 'node:net';
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
 * There is no secret field. `RAPHAEL_SERVER_API_KEY` is the only credential input and it never appears in
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

/**
 * Why a host is not one this machine could ever bind, for shapes that are clearly something else: a
 * URL, an address with a port, the bracketed IPv6 form a URL uses, or four numbers that are not an
 * IPv4 address. Anything else is left for the system to judge when the server listens.
 */
const hostShapeProblem = (value: string): string | undefined => {
  if (value.includes('://'))
    return 'host must be an address, not a URL; leave out the scheme and any port';
  if (value.startsWith('[') || value.endsWith(']')) {
    return 'host must be an IPv6 address without brackets, such as ::1';
  }
  if (/^[^:]*:\d*$/u.test(value))
    return 'host must be an address without a port; give the port on its own';
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(value) && !isIPv4(value)) {
    return 'host must be a valid IPv4 address, with each of its four numbers from 0 to 255';
  }
  return undefined;
};

/** A host is an address to bind, not a URL. */
const Host = Schema.String.pipe(
  Schema.filter((value) =>
    value.length > 0 && value.length <= 255 && !UNPRINTABLE.test(value)
      ? (hostShapeProblem(value) ?? true)
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
export const CONFIGURED_PORT_RANGE = { min: 1, max: 65_535 } as const;

const ConfiguredPort = boundedInteger('port', CONFIGURED_PORT_RANGE.min, CONFIGURED_PORT_RANGE.max);

const ServerShape = Schema.Struct({
  host: Schema.optional(Host),
  port: Schema.optional(ConfiguredPort),
});

const DatabaseShape = Schema.Struct({
  path: Schema.optional(DatabasePath),
});

const FileShape = Schema.Struct({
  server: Schema.optional(ServerShape),
  database: Schema.optional(DatabaseShape),
});

/** The keys each mapping accepts, from the schemas themselves, for "unknown key" suggestions. */
const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  '': Object.keys(FileShape.fields),
  server: Object.keys(ServerShape.fields),
  database: Object.keys(DatabaseShape.fields),
};

export const CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  databasePath: './data/raphael.sqlite',
} as const;

export interface ServerOptions {
  readonly host: string;
  /** 0 only through the programmatic interface; a configuration file cannot ask for one. */
  readonly port: number;
}

export interface DatabaseSettings {
  /** Already absolute. Resolved against the configuration file's directory, or the invocation directory. */
  readonly databasePath: string;
}

/** Validated, defaulted, non-secret options. Holds no credential and is safe to inspect. */
export interface BackendOptions {
  readonly server: ServerOptions;
  readonly database: DatabaseSettings;
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
  context: {
    readonly baseDirectory: string;
    readonly label: string;
    /** Values given as `server serve` flags. They win over the file and are checked by the same schemas. */
    readonly overrides?: OptionOverrides;
    /** Where a relative `databasePath` override resolves: the directory the command was run in. */
    readonly overrideDirectory?: string;
  },
): BackendOptions => {
  const overrides = context.overrides ?? {};
  checkOverrides(overrides);
  const decoded = decodeFileShape(value ?? {});
  if (Either.isLeft(decoded)) {
    // Every problem is reported, one per line, so an operator fixes everything in one pass rather than
    // restarting once per mistake. Paths are option names; the values are the operator's own.
    configurationFailure(
      'config_invalid',
      `${capitalized(context.label)} is not valid:\n${describeIssues(decoded.left)
        .map((line) => `  ${line}`)
        .join('\n')}`,
    );
  }

  const file = decoded.right;
  const fromFile = file.database?.path ?? CONFIG_DEFAULTS.databasePath;
  const [databasePath, databaseBase] =
    overrides.databasePath === undefined
      ? [fromFile, context.baseDirectory]
      : [overrides.databasePath, context.overrideDirectory ?? context.baseDirectory];
  return {
    server: {
      host: overrides.host ?? file.server?.host ?? CONFIG_DEFAULTS.host,
      port: (overrides.port as number | undefined) ?? file.server?.port ?? CONFIG_DEFAULTS.port,
    },
    database: {
      databasePath: isAbsolute(databasePath)
        ? resolve(databasePath)
        : resolve(databaseBase, databasePath),
    },
  };
};

/** Options given on the command line. `port` arrives as typed when it is not a number. */
export interface OptionOverrides {
  readonly host?: string;
  readonly port?: number | string;
  readonly databasePath?: string;
}

/** The configuration file's own path, as `--config` gives it: a path, like the database's. */
const ConfigPath = Schema.String.pipe(
  Schema.filter((value) =>
    value.trim().length > 0 && value.length <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(value)
      ? true
      : 'config path must be a non-empty path with no control characters',
  ),
);

/** The flags `server serve` takes: the overrides, and the configuration file they override. */
export type ServeFlags = OptionOverrides & { readonly configPath?: string };

/**
 * Each override is checked by the schema of the file key it replaces, and reported by its flag;
 * `--config` by the path rule, so an empty one is a mistake in the command like an empty `--database`.
 */
const OVERRIDE_FLAGS = [
  { key: 'configPath', flag: '--config', schema: ConfigPath },
  { key: 'host', flag: '--host', schema: Host },
  { key: 'port', flag: '--port', schema: ConfiguredPort },
  { key: 'databasePath', flag: '--database', schema: DatabasePath },
] as const;

/**
 * Refuse flag values the file's own schemas would refuse, by flag name. A mistake in the command, so
 * it has its own reason: the command as typed cannot succeed, whatever the configuration says.
 */
export const checkOverrides = (overrides: ServeFlags): void => {
  const problems = overrideProblems(overrides);
  if (problems.length > 0) {
    configurationFailure(
      'option_invalid',
      `The server serve options are not valid:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
  }
};

const overrideProblems = (overrides: ServeFlags): string[] =>
  OVERRIDE_FLAGS.flatMap(({ key, flag, schema }) => {
    const given = overrides[key];
    if (given === undefined) return [];
    const decoded = Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(given);
    return Either.isLeft(decoded)
      ? describeIssues(decoded.left).map((line) => line.replace(/^\(root\)/u, flag))
      : [];
  });

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * One line per real problem.
 *
 * The schema reports each optional key's failure once per union branch, and the `undefined` branch
 * ("Expected undefined, actual ...") is never what the operator got wrong, so those are dropped. The
 * rest is reworded: an unknown key suggests the nearest known one, and a type mismatch says what the
 * key takes rather than the schema's internal spelling of it.
 */
const describeIssues = (error: ParseResult.ParseError): string[] => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const issue of ParseResult.ArrayFormatter.formatErrorSync(error)) {
    if (issue.message.startsWith('Expected undefined')) continue;
    const path = issue.path.map(String);
    const name = path.join('.') || '(root)';
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`${name}: ${describeIssue(issue, path)}`);
  }
  return lines;
};

const describeIssue = (issue: ParseResult.ArrayFormatterIssue, path: readonly string[]): string => {
  if (issue._tag === 'Unexpected') {
    const parent = path.slice(0, -1).join('.');
    const known = KNOWN_KEYS[parent] ?? [];
    const key = path.at(-1) ?? '';
    const nearest = nearestKey(key, known);
    return nearest === undefined
      ? `unknown key. Allowed keys: ${known.join(', ')}.`
      : `unknown key. Did you mean "${nearest}"?`;
  }
  const actual = /actual (.*)$/su.exec(issue.message)?.[1];
  if (issue.message.startsWith('Expected {')) return 'must be a mapping of keys.';
  if (issue.message.startsWith('Expected number')) {
    return actual !== undefined && /^"\d+"$/u.test(actual)
      ? `must be a number, got the string ${actual}. Remove the quotes.`
      : `must be a number${actual === undefined ? '' : `, got ${actual}`}.`;
  }
  if (issue.message.startsWith('Expected an integer')) {
    return `must be a whole number${actual === undefined ? '' : `, got ${actual}`}.`;
  }
  if (issue.message.startsWith('Expected string')) {
    return `must be text${actual === undefined ? '' : `, got ${actual}`}.`;
  }
  // The schemas' own refinement sentences ("port must be a whole number between 1 and 65535").
  return `${issue.message.replace(/^[a-z ]+ must/u, 'must')}.`;
};

/** The closest known key within two edits, when there is exactly one sensible guess. */
const nearestKey = (key: string, known: readonly string[]): string | undefined => {
  let best: { readonly key: string; readonly distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { key: candidate, distance };
    }
  }
  return best?.key;
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/**
 * Re-check already-resolved options at a programmatic boundary, and return a snapshot of what was
 * checked.
 *
 * `serve` is importable, so "the YAML loader validated it" is only true of options that came through
 * the YAML loader. A caller can construct a `BackendOptions` literal directly - the type is an
 * ordinary structure of `number` and `string`. Bounds that hold for a file and not for a caller are
 * not bounds.
 *
 * Startup is asynchronous, so an object that was valid when it was inspected could be a different
 * object by the time it is used. Every value is therefore read **once**, into a local, and the result
 * is a fresh structure built from what was actually validated.
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
  };

  const ephemeralPort = supplied.port === 0;
  const decoded = decodeFileShape({
    server: { host: supplied.host, ...(ephemeralPort ? {} : { port: supplied.port }) },
    database: { path: supplied.databasePath },
  });
  if (Either.isLeft(decoded)) {
    configurationFailure(
      'config_invalid',
      `The supplied server options are not valid:\n${describeIssues(decoded.left)
        .map((line) => `  ${line}`)
        .join('\n')}`,
    );
  }
  if (!Number.isSafeInteger(supplied.port) || supplied.port < 0) {
    configurationFailure(
      'config_invalid',
      'The supplied server options are not valid: server.port must be 0 or a whole number between 1 and 65535.',
    );
  }
  if (!isAbsolute(supplied.databasePath)) {
    configurationFailure(
      'config_invalid',
      'The supplied server options are not valid: database.path must already be resolved to an absolute path.',
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
    },
  };
};

/** The directory a relative database path resolves against, given where the configuration came from. */
export const baseDirectoryFor = (configPath: string | undefined, cwd: string): string =>
  configPath === undefined ? resolve(cwd) : dirname(resolve(configPath));
