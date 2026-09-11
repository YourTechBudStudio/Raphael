/**
 * What this server writes to an operator's terminal.
 *
 * There is no access log. Startup, shutdown, replay collection that did something, and failures we
 * did not expect are the whole vocabulary, because those are the events an operator acts on and
 * everything else would be volume that has to be stored, rotated, and kept free of content.
 *
 * The field list is a whitelist, not a filter. Nothing arrives here from a request except a matched
 * route's own label - never the path. A request path is caller-controlled text and can carry a
 * credential or a note title exactly as a body can; stripping a query string would not change that,
 * so the raw URL is never given to this module in the first place. Unmatched requests are one fixed
 * word.
 *
 * Also absent by construction: headers, bodies, error `details`, configuration objects, credentials,
 * and cause chains. A retained cause can carry SQL text and bound parameters, which is why phase 04
 * keeps it in memory for a debugger and forbids printing it, and this module honors that.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** The label a log uses for a request that matched no published route. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Methods a log may name. Anything else is reported as `other`, so the field stays bounded. */
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const methodLabel = (method: string | undefined): string =>
  method !== undefined && KNOWN_METHODS.has(method) ? method : 'other';

/** Values a log line may carry. Structured, so a reader is never parsing prose. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  readonly log: (level: LogLevel, event: string, fields?: LogFields) => void;
}

const format = (level: LogLevel, event: string, fields: LogFields): string => {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`)
    .join(' ');
  return rendered.length === 0
    ? `[raphael] ${level} ${event}`
    : `[raphael] ${level} ${event} ${rendered}`;
};

/** The default logger. Warnings and errors go to stderr so they survive a redirected stdout. */
export const consoleLogger: Logger = {
  log: (level, event, fields = {}) => {
    const line = format(level, event, fields);
    if (level === 'info') process.stdout.write(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  },
};

/** A logger that keeps its lines. Tests assert on what was written, and on what was not. */
export const recordingLogger = (): Logger & {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[];
} => {
  const lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  return {
    lines,
    log: (level, event, fields = {}) => {
      lines.push({ level, event, fields });
    },
  };
};

export const silentLogger: Logger = { log: () => {} };
