/**
 * The one success renderer.
 *
 * A command hands over its result once: the data for the JSON envelope, and how to print it for a
 * person. With `--json` exactly one document goes to stdout:
 *
 * ```json
 * { "ok": true, "command": "list", "items": [...], "page": {...}, "warnings": [...] }
 * ```
 *
 * The data keys are the command's own (`entity`, `node`, `items`, ...) and are fixed per command; the
 * envelope around them is fixed for every command. Without `--json`, the result lines go to stdout
 * and everything that is not a result - page notes, warnings, a next step - goes to stderr, so
 * `raphael list / | wc -l` counts rows and nothing else.
 */

import type { Session } from './command.ts';
import { EXIT_OK, type ExitCode } from './exit.ts';
import { writeJson, writeLine, type Streams } from './output.ts';

/** Something worth knowing about a success that did not stop it. */
export interface Warning {
  readonly code: string;
  readonly message: string;
}

export interface Success {
  /** The command's data keys, beside `ok` and `command`. */
  readonly data: Readonly<Record<string, unknown>>;
  /** The result for a person: every line goes to stdout. */
  readonly lines: () => readonly string[];
  /** Lines for a person that are not results: page notes and next steps, on stderr. */
  readonly notes?: readonly string[];
  readonly warnings?: readonly Warning[];
}

export const renderSuccess = (streams: Streams, session: Session, success: Success): ExitCode => {
  const warnings = success.warnings ?? [];
  const { invocation } = session;
  if (invocation.json) {
    writeJson(streams.out, {
      ok: true,
      command: invocation.command,
      ...success.data,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
    return EXIT_OK;
  }
  for (const line of success.lines()) writeLine(streams.out, line);
  for (const warning of warnings) writeLine(streams.err, `warning: ${warning.message}`);
  for (const note of success.notes ?? []) writeLine(streams.err, note);
  return EXIT_OK;
};
