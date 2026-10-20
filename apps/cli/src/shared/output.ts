/**
 * Writing to a terminal, safely.
 *
 * Two rules shape everything here.
 *
 * **Streams carry meaning.** Results go to stdout and nothing else does, so `raphael get x | jq` works
 * and `raphael list x > file` contains a list. Diagnostics, progress, and every failure go to stderr.
 *
 * **Server text is data, not markup.** A title, a description, a slug, an element name - all of it was
 * authored by someone and arrives over a network. Written straight to a terminal, a control sequence
 * in any of it can move the cursor, recolour the screen, clear scrollback, or redraw a line to say
 * something other than what happened. Every server-provided string is escaped before it is printed.
 * JSON output does not need this - `JSON.stringify` escapes control characters itself - and is left
 * exactly as the operation returned it so that machine consumers get the real payload.
 */

/**
 * Render server-provided text inside a single structured line.
 *
 * Used for titles, slugs, tags, paths, messages, and detail values - anything printed as one field
 * on one line. Line separators are escaped here as well as control characters, because a title may
 * legitimately contain a newline and a newline inside a labelled line is indistinguishable from
 * another labelled line. Text that reads `Backend\nslug: something-else` would otherwise print a
 * second field that no server ever sent.
 *
 * Bidirectional overrides and isolates are escaped for the same reason: they reorder what is
 * displayed without changing what is stored, so the line a person reads can differ from the value
 * they would get back.
 */
export const forTerminal = (value: string): string => escapeWith(INLINE_UNSAFE, value);

/**
 * Render a document for its own region of the output.
 *
 * Only for content that is deliberately multi-line and printed as a block of its own - a Markdown
 * body, after a blank line. Newlines and tabs survive because they are the formatting the person
 * asked to see; mangling them would make the command useless for reading a note. Everything that
 * steers a terminal rather than filling it is still escaped.
 *
 * This is deliberately not used for anything that shares a line with a label.
 */
export const forTerminalBlock = (value: string): string => escapeWith(BLOCK_UNSAFE, value);

// C0 except tab and newline, DEL, and the C1 range: everything that steers a terminal.
// oxlint-disable-next-line no-control-regex
const BLOCK_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

// The same, plus tab and newline, plus the bidirectional overrides and isolates.
// oxlint-disable-next-line no-control-regex
const INLINE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const escapeWith = (pattern: RegExp, value: string): string =>
  value.replace(pattern, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });

export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * The real streams, guarded so a reader that goes away is never an error.
 *
 * `raphael list / | head -1` closes the pipe after one line. Node then fails the next write with
 * EPIPE, asynchronously, as an 'error' event; with no listener that event crashes the process with a
 * stack trace, and whether it happens depends on how much output was still buffered. Here each stream
 * gets one listener that marks it closed, and nothing more is written to it. The exit code is
 * untouched: it describes the operation, and the operation's outcome does not change because nobody
 * read about it.
 *
 * Installed once, by the entry point. Tests substitute their own streams so nothing is captured by
 * intercepting globals.
 */
export const guardedProcessStreams = (): Streams => {
  const closed = { out: false, err: false };
  const guard = (stream: NodeJS.WriteStream, which: 'out' | 'err'): void => {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      const wasOpen = !closed[which];
      closed[which] = true;
      // A reader that left is not news. Anything else is, and stderr is the only place to say it.
      if (wasOpen && which === 'out' && error.code !== 'EPIPE' && !closed.err) {
        process.stderr.write(`Could not write the output (${error.code ?? 'unknown error'}).\n`);
      }
    });
  };
  guard(process.stdout, 'out');
  guard(process.stderr, 'err');
  return {
    out: (text) => {
      if (!closed.out) process.stdout.write(text);
    },
    err: (text) => {
      if (!closed.err) process.stderr.write(text);
    },
  };
};

export const writeLine = (write: (text: string) => void, text = ''): void => {
  write(`${text}\n`);
};

/**
 * Machine-readable output: exactly one JSON document per invocation, on one line.
 *
 * Success goes to stdout as the envelope `success.ts` builds; failure goes to stderr as the error
 * document `failure.ts` builds. Neither ever carries a response body the client did not decode, a
 * decoder message about one, or a cause chain.
 */
export const writeJson = (write: (text: string) => void, value: unknown): void => {
  writeLine(write, JSON.stringify(value));
};
