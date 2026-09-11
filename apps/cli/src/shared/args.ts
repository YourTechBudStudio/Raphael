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

/** A command was invoked wrongly. Nothing was sent; nothing is pending. */
export class UsageError extends Error {
  /** The command to suggest help for, when there is a specific one. */
  readonly command: string | undefined;
  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

export type OptionConfig = Record<
  string,
  { readonly type: 'string' | 'boolean'; readonly multiple?: boolean; readonly short?: string }
>;

export type OptionValue = string | boolean | (string | boolean)[] | undefined;

export interface ParsedArgs {
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
}

/**
 * Parse one command's arguments.
 *
 * `strict` is on, so an unknown flag is an error rather than a positional. That matters more than it
 * looks: a mistyped `--titel` silently becoming a positional would turn a creation with no title into
 * a creation at a nonsense address.
 */
export const parseArgs = (
  argv: readonly string[],
  options: OptionConfig,
  command: string,
): ParsedArgs => {
  try {
    const parsed = nodeParseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
    });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError((error as Error).message, command);
  }
};

/** A flag that must be a single string, if present at all. */
export const stringOption = (
  parsed: ParsedArgs,
  name: string,
  command: string,
): string | undefined => {
  const value = parsed.values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`--${name} takes one value.`, command);
  }
  return value;
};

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
 * A flag that must be a whole number within a range.
 *
 * Parsed strictly: `--limit 5x`, `--limit 1e3`, and `--limit 5.5` are all refused rather than
 * silently becoming 5. A pagination bound that quietly changes is a page that quietly lies.
 */
export const integerOption = (
  parsed: ParsedArgs,
  name: string,
  command: string,
  bounds: { readonly min: number; readonly max: number },
): number | undefined => {
  const raw = stringOption(parsed, name, command);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--${name} must be a whole number. Got "${raw}".`, command);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new UsageError(
      `--${name} must be between ${bounds.min} and ${bounds.max}. Got "${raw}".`,
      command,
    );
  }
  return value;
};

/** A flag whose value must come from a fixed set. */
export const choiceOption = <T extends string>(
  parsed: ParsedArgs,
  name: string,
  command: string,
  choices: readonly T[],
): T | undefined => {
  const raw = stringOption(parsed, name, command);
  if (raw === undefined) return undefined;
  if (!(choices as readonly string[]).includes(raw)) {
    throw new UsageError(`--${name} must be one of ${choices.join(', ')}. Got "${raw}".`, command);
  }
  return raw as T;
};

/** Whether the caller asked for help rather than for the command to run. */
export const wantsHelp = (argv: readonly string[]): boolean =>
  argv.includes('--help') || argv.includes('-h') || argv.includes('help');
