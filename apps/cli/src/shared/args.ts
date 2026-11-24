/**
 * Argument parsing, on `node:util.parseArgs` and nothing else.
 *
 * No argument-parsing library. Help has to work with no network, no configuration, no credential, and
 * without loading the backend, and the cheapest way to guarantee that is for the whole thing to be a
 * few hundred lines of our own code with no imports that could pull something in. It also keeps the
 * grammar honest: every flag a command accepts is declared in that command's own file, so an unknown
 * flag is refused rather than ignored.
 *
 * This is deliberately not a command framework. There is one dispatch table in `main.ts` and each
 * command parses its own options. Generalizing that would buy nothing for five commands.
 */

import { parseArgs as nodeParseArgs } from 'node:util';

/**
 * A command was invoked wrongly. Nothing was sent; nothing is pending.
 *
 * The message says what is wrong. `fix`, when the refusal knows the exact correction - a spelling it
 * meant, the option on its own, the command with its options moved - is the next step in place of
 * the generic pointer to help, so the correction is said once, as the hint.
 */
/**
 * One argument as it was typed and what it most likely meant. The failure renderer repeats the
 * whole command with it replaced, so the hint is a command to run rather than a word to swap in.
 */
export interface Correction {
  readonly typed: string;
  /** One argument, or several in its place: `9` typed as a path is `--id 9`. */
  readonly suggested: string | readonly string[];
}

/**
 * The flag or argument a refusal is about. Every refusal about one names it first, as in
 * `--limit must be ...`, `--title: A title is required.` or `path: A path must ...`, so it is read
 * from there rather than passed beside a message that already says it.
 */
const namedField = (message: string): string | undefined => {
  const flag = /^(--[a-z][a-z0-9-]*|-[a-zA-Z])(?=[: ]|$)/u.exec(message)?.[1];
  if (flag !== undefined) return flag;
  const argument = /^(path|destination)(?: slug| \(\d+\w\w\))?:/u.exec(message)?.[1];
  return argument === undefined ? undefined : `<${argument}>`;
};

export class UsageError extends Error {
  /** The command to suggest help for, when there is a specific one. */
  readonly command: string | undefined;
  /** The flag or argument the refusal is about, as typed: `--title`, `-q`, `<path>`. */
  readonly field: string | undefined;
  /** The next step in words; also what is printed when the corrected command cannot be. */
  readonly fix: string | undefined;
  readonly correction: Correction | undefined;
  constructor(message: string, command?: string, fix?: string, correction?: Correction) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
    this.fix = fix;
    this.correction = correction;
    this.field = namedField(message);
  }
}

/** What a refusal says is wrong, and the exact correction when it knows one. */
interface Diagnostic {
  readonly message: string;
  readonly fix?: string;
  readonly correction?: Correction;
}

/** The range a whole-number option accepts. */
export interface WholeRange {
  readonly min: number;
  readonly max: number;
}

/**
 * What the parser knows about one option. A string option carries an example value, typed into the
 * hint when the value is missing; `leadingDash: false` says no value of it starts with a dash, so the
 * `--name=value` advice for such values is not given.
 */
export type OptionSpec =
  | {
      readonly type: 'boolean';
      readonly multiple?: boolean;
      readonly short?: string;
    }
  | {
      readonly type: 'string';
      readonly multiple?: boolean;
      readonly short?: string;
      /** The option takes a whole number in this range. */
      readonly whole?: WholeRange;
      readonly example: string;
      readonly leadingDash?: false;
    };

export type OptionConfig = Record<string, OptionSpec>;

export type OptionValue = string | boolean | (string | boolean)[] | undefined;

export interface ParseDiagnostics {
  /**
   * Options of other commands worth pointing at: an unknown option found here names the command it
   * belongs to. Only what that command is for belongs here, so the pointer is to what was meant.
   */
  readonly otherCommands?: Readonly<Record<string, OptionConfig>>;
  /** What to use instead of an option this command does not take, by the option's name. */
  readonly alternatives?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
  /** The options this was parsed with, so a value is checked against its own declaration. */
  readonly options: OptionConfig;
}

/**
 * The rule a whole-number option states when its value is wrong, whatever is wrong with it: the
 * same sentence for `--skip -1`, `--skip=-1` and `--skip x`.
 */
export const wholeNumberRule = (flag: string, range: WholeRange): string =>
  range.max === Number.MAX_SAFE_INTEGER
    ? `${flag} must be ${range.min === 0 ? 'zero or a positive' : 'a positive'} whole number.`
    : `${flag} must be a whole number between ${range.min} and ${range.max}.`;

/** Insertions, deletions and substitutions between two words, for spelling suggestions. */
export const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
};

/** An option's example value as it would be typed into a shell. */
const exampleOf = (option: OptionSpec): string => {
  const value = option.type === 'string' ? option.example : '';
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
};

/**
 * Options that were renamed, by their old name: the old spelling is refused with the new one, and a
 * close misspelling of either is pointed at the new one.
 */
const RENAMED_OPTIONS: Readonly<Record<string, string>> = { format: 'return-format' };

/**
 * The option a misspelled name most likely meant, or nothing when that is not clear.
 *
 * An option the name begins wins (`--lim` is `--limit`, `--dir` is `--direct`); otherwise the
 * closest within two edits of its name or a former one. Options already given are left out unless
 * they repeat, since suggesting one would only lead to "can be given only once". When two options
 * are equally good, nothing is suggested: picking one would be a guess presented as a correction.
 */
const closestOption = (
  name: string,
  options: OptionConfig,
  given: ReadonlySet<string>,
): string | undefined => {
  if (name.length < 3) return undefined;
  const lower = name.toLowerCase();
  const available = (option: string): boolean =>
    options[option] !== undefined && (!given.has(option) || options[option].multiple === true);
  const spellings: ReadonlyArray<readonly [string, string]> = [
    ...Object.keys(options).map((option): [string, string] => [option, option]),
    ...Object.entries(RENAMED_OPTIONS),
  ].filter(([, option]) => available(option));
  const only = (candidates: Iterable<string>): string | undefined => {
    const distinct = [...new Set(candidates)];
    return distinct.length === 1 ? distinct[0] : undefined;
  };
  const begun = spellings.filter(([spelling]) => spelling.startsWith(lower));
  if (begun.length > 0) return only(begun.map(([, option]) => option));
  const distances = new Map<string, number>();
  for (const [spelling, option] of spellings) {
    const distance = editDistance(lower, spelling);
    distances.set(option, Math.min(distance, distances.get(option) ?? Infinity));
  }
  const best = Math.min(...distances.values());
  if (best > 2) return undefined;
  return only([...distances].filter(([, distance]) => distance === best).map(([option]) => option));
};

const parseDiagnostic = (
  argv: readonly string[],
  options: OptionConfig,
  command: string,
  diagnostics: ParseDiagnostics,
): Diagnostic => {
  const loose = nodeParseArgs({
    args: [...argv],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  for (const token of loose.tokens) {
    if (token.kind !== 'option') continue;
    const option = options[token.name];
    if (!option) {
      if (command === 'search' && token.rawName === '-r') {
        return {
          message: 'search does not take -r: it includes descendants by default.',
          fix: 'Remove -r, or use --direct for direct children only.',
        };
      }
      if (command === 'update' && token.name === 'metadata') {
        return { message: '--metadata is set once, at create. It cannot be changed with update.' };
      }
      const renamed = RENAMED_OPTIONS[token.name];
      if (renamed !== undefined && options[renamed]) {
        return {
          message: `--${token.name} has been renamed to --${renamed}.`,
          fix: `Use --${renamed} with --json.`,
        };
      }
      // `-r=1` is split by the parser into -r, -= and -1, so the token refused is one nobody typed.
      const cluster = /^-([a-zA-Z])=/.exec(argv[token.index] ?? '');
      const letter = cluster?.[1];
      const clustered = Object.entries(options).find(([, config]) => config.short === letter);
      if (letter !== undefined && clustered?.[1].type === 'boolean') {
        return { message: `-${letter} does not take a value.`, fix: `Use -${letter} on its own.` };
      }
      // Never print inline values or arbitrary submitted text as part of a diagnostic.
      const printable = /^--?[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(token.rawName);
      const refusal = printable
        ? `${command} does not take ${token.rawName}.`
        : `${command} was given an option with characters no option uses.`;
      const alternative = diagnostics.alternatives?.[token.name];
      if (alternative !== undefined) return { message: refusal, fix: alternative };
      const given = new Set(
        loose.tokens.flatMap((other) =>
          other.kind === 'option' && options[other.name] !== undefined ? [other.name] : [],
        ),
      );
      const suggestion = closestOption(token.name, options, given);
      // Suggested only when the command it makes parses: `--port-x` at the end is not `--port`
      // with no value, and `--prot=1` is not a flag that takes none.
      const word = argv[token.index] ?? '';
      const corrected =
        word === token.rawName
          ? `--${suggestion}`
          : word.startsWith(`${token.rawName}=`)
            ? `--${suggestion}${word.slice(token.rawName.length)}`
            : undefined;
      if (
        suggestion !== undefined &&
        corrected !== undefined &&
        parses(argv.with(token.index, corrected), options)
      ) {
        return {
          message: refusal,
          fix: `Did you mean --${suggestion}?`,
          correction: { typed: token.rawName, suggested: `--${suggestion}` },
        };
      }
      // A short spelling such as `-q` is unknown here by its letter, and known there by its short.
      const short = token.rawName === `-${token.name}`;
      const matches = Object.entries(diagnostics.otherCommands ?? {})
        .filter(
          ([name, config]) =>
            name !== command &&
            (config[token.name] !== undefined ||
              (short && Object.values(config).some((other) => other.short === token.name))),
        )
        .map(([name]) => name);
      const preferred = matches.includes('update') ? 'update' : matches[0];
      return {
        message: refusal,
        ...(preferred === undefined
          ? printable
            ? {}
            : { fix: 'Give each option and its value as separate arguments.' }
          : { fix: `Run "raphael ${preferred} --help" for that option.` }),
      };
    }
    if (option.type === 'boolean' && token.value !== undefined) {
      return {
        message: `--${token.name} does not take a value.`,
        fix: `Use --${token.name} on its own.`,
      };
    }
    if (
      option.type === 'string' &&
      (token.value === undefined || (!token.inlineValue && token.value.startsWith('-')))
    ) {
      // `--skip -1` reads as an option with no value followed by `-1`. For a number, the advice to
      // write `--skip=-1` would only lead to the range rule, so the rule is what is said.
      if (token.value !== undefined && option.whole !== undefined && /^-\d/.test(token.value)) {
        return { message: wholeNumberRule(`--${token.name}`, option.whole) };
      }
      // Named as typed: `-q` where `-q` was given. Values that can start with a dash are joined
      // with `=`; a number or a slug never does, so that advice would only lead to another refusal.
      const dash =
        option.whole === undefined && option.leadingDash !== false
          ? ` To pass a value that starts with a dash, join it to --${token.name} with =.`
          : '';
      return {
        message: `${token.rawName} needs a value.`,
        fix: `For example: ${token.rawName} ${exampleOf(option)}.${dash}`,
      };
    }
  }
  return { message: 'The arguments are invalid. Check the option names and their values.' };
};

type Tokens = NonNullable<ReturnType<typeof nodeParseArgs>['tokens']>;

/** The repeat of an option that may be given once, as it was typed, if there is one. */
const repeatedOption = (tokens: Tokens, options: OptionConfig): string | undefined => {
  const given = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option' || options[token.name]?.multiple === true) continue;
    if (given.has(token.name)) return token.rawName;
    given.add(token.name);
  }
  return undefined;
};

/** Whether arguments parse as given, repeats included: what a suggested command must do. */
export const parses = (argv: readonly string[], options: OptionConfig): boolean => {
  try {
    const { tokens } = nodeParseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    return repeatedOption(tokens, options) === undefined;
  } catch {
    return false;
  }
};

/**
 * Parse one command's arguments.
 *
 * `strict` is on, so an unknown flag is an error rather than a positional. That matters more than it
 * looks: a mistyped `--titel` silently becoming a positional would turn a creation with no title into
 * a creation at a nonsense address.
 *
 * A flag that is not declared `multiple` may be given once. `node:util` keeps the last of several
 * values, so `archive --id 7 --id 6` would archive 6 and `update --title A --title B` would write B:
 * whichever value the caller meant, one of them was silently dropped. Repeats are counted from the
 * parser's own tokens, so `-r -r`, `-rr`, and `--json --json` are refused the same way.
 */
export const parseArgs = (
  argv: readonly string[],
  options: OptionConfig,
  command: string,
  diagnostics: ParseDiagnostics = {},
): ParsedArgs => {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    const { message, fix, correction } = parseDiagnostic(argv, options, command, diagnostics);
    throw new UsageError(message, command, fix, correction);
  }

  for (const token of parsed.tokens) {
    // `-q=x` gives -q the value `=x`, where `--query=x` gives it `x`: refused, so the two spellings
    // cannot quietly differ.
    if (
      token.kind === 'option' &&
      /^-[a-zA-Z]$/.test(token.rawName) &&
      token.inlineValue === true &&
      token.value?.startsWith('=') === true
    ) {
      const option = options[token.name];
      const example = option === undefined ? '' : exampleOf(option);
      throw new UsageError(
        `${token.rawName} takes its value after a space, not after =.`,
        command,
        `Write ${token.rawName} ${example}, or --${token.name}=${example}.`,
      );
    }
  }

  const repeated = repeatedOption(parsed.tokens, options);
  // Named as typed the second time: `-r -r` is about -r.
  if (repeated !== undefined) throw new UsageError(`${repeated} can be given only once.`, command);

  return { values: parsed.values, positionals: parsed.positionals, options };
};

/**
 * A single-value string flag, if present at all.
 *
 * Only for flags declared `type: 'string'` without `multiple`. `parseArgs` has already refused a
 * repeat, so such a flag holds exactly one string or nothing.
 */
export const stringOption = (parsed: ParsedArgs, name: string): string | undefined =>
  parsed.values[name] as string | undefined;

export const booleanOption = (parsed: ParsedArgs, name: string): boolean =>
  parsed.values[name] === true;

export const stringListOption = (parsed: ParsedArgs, name: string): readonly string[] => {
  const value = parsed.values[name];
  if (value === undefined) return [];
  // A repeatable flag declared as `string` only ever yields strings; the boolean arm exists in the
  // parser's own type, not in ours.
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * A flag that must be a whole number, in the range its declaration gives.
 *
 * Parsed strictly: `--limit 5x`, `--limit 1e3`, and `--limit 5.5` are all refused rather than
 * silently becoming 5. A pagination bound that quietly changes is a page that quietly lies.
 */
export const integerOption = (
  parsed: ParsedArgs,
  name: string,
  command: string,
): number | undefined => {
  const spec = parsed.options[name];
  const range = spec?.type === 'string' ? spec.whole : undefined;
  if (range === undefined) throw new Error(`--${name} is not declared as a whole number.`);
  const raw = stringOption(parsed, name);
  if (raw === undefined) return undefined;
  const rule = wholeNumberRule(`--${name}`, range);
  if (!/^-?\d+$/.test(raw)) throw new UsageError(rule, command);
  const value = Number(raw);
  if (range.max === Number.MAX_SAFE_INTEGER && value > range.max) {
    throw new UsageError(`--${name} is too large. Give a smaller whole number.`, command);
  }
  if (value < range.min || value > range.max) throw new UsageError(rule, command);
  return value;
};

/** A flag whose value must come from a fixed set. */
export const choiceOption = <T extends string>(
  parsed: ParsedArgs,
  name: string,
  command: string,
  choices: readonly T[],
): T | undefined => {
  const raw = stringOption(parsed, name);
  if (raw === undefined) return undefined;
  if (!(choices as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${choices.join(', ')}.`, command);
  }
  return raw as T;
};

/**
 * Whether an option appears among the option tokens the parser finds with this command's own
 * options.
 *
 * Decided from tokens, so a value is never mistaken for a request: in `search / -q help` and
 * `search / -q -h` the word belongs to `-q`, and after `--` nothing is an option. A cluster such as
 * `-rh` counts, because the parser expands it.
 *
 * Not strict, so an unknown flag beside the one asked about does not hide it: help is still shown,
 * and a usage error is still reported in JSON when `--json` was given.
 */
export const hasOption = (argv: readonly string[], options: OptionConfig, name: string): boolean =>
  nodeParseArgs({
    args: [...argv],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  }).tokens.some((token) => token.kind === 'option' && token.name === name);

/** Whether the caller asked for help rather than for the command to run. */
export const wantsHelp = (argv: readonly string[], options: OptionConfig): boolean =>
  nodeParseArgs({
    args: [...argv],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  }).tokens.some(
    (token) => token.kind === 'option' && token.name === 'help' && token.value === undefined,
  );

/**
 * Whether `--json` appears before `--`, for a command whose options are not known.
 *
 * Used only when no command was recognized, so a usage error about an unknown command can still be
 * reported as a JSON document to a caller that asked for one.
 */
export const mentionsJson = (argv: readonly string[]): boolean => {
  for (const token of argv) {
    if (token === '--') return false;
    if (token === '--json' || token.startsWith('--json=')) return true;
  }
  return false;
};
