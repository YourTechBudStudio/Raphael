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

import { fstatSync, writeSync } from 'node:fs';

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

// The same, plus tab and newline, the Unicode line and paragraph separators, and the bidirectional
// overrides and isolates.
const INLINE_UNSAFE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

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
 * Any other failure to write results - a full disk, a file size limit - is said once on stderr, so a
 * caller holding a truncated file is told. Standard output redirected to a file is written here with
 * `writeSync` in a loop, because Node's own file stream makes one `writeSync` call and drops whatever
 * a short write left over without a word.
 *
 * Installed once, by the entry point. Tests substitute their own streams so nothing is captured by
 * intercepting globals.
 */
export const guardedProcessStreams = (): Streams => {
  const closed = { out: false, err: false };
  let noted = false;
  // A reader that left is not news. Anything else is, and stderr is the only place to say it.
  const outputFailed = (code: string | undefined): void => {
    closed.out = true;
    if (noted || code === 'EPIPE' || closed.err) return;
    noted = true;
    process.stderr.write(`Could not write the output (${code ?? 'unknown error'}).\n`);
  };
  process.stdout.on('error', (error: NodeJS.ErrnoException) => outputFailed(error.code));
  process.stderr.on('error', () => {
    closed.err = true;
  });
  const toFile = isRegularFile(1);
  return {
    out: (text) => {
      if (closed.out) return;
      if (!toFile) {
        process.stdout.write(text);
        return;
      }
      const bytes = Buffer.from(text, 'utf8');
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const written = writeSync(1, bytes, offset);
          if (written <= 0) return outputFailed('a short write');
          offset += written;
        }
      } catch (error) {
        outputFailed((error as NodeJS.ErrnoException).code);
      }
    },
    err: (text) => {
      if (!closed.err) process.stderr.write(text);
    },
  };
};

const isRegularFile = (descriptor: number): boolean => {
  try {
    return fstatSync(descriptor).isFile();
  } catch {
    return false;
  }
};

/**
 * Wait until what was written to the real streams has been handed to the system, so the process can
 * exit without cutting off output still queued for a pipe. A write that fails resolves too: its
 * failure was already reported, or there is nowhere left to report it.
 */
export const flushProcessStreams = async (): Promise<void> => {
  const flushed = (stream: NodeJS.WriteStream): Promise<void> =>
    stream.destroyed || stream.writableEnded
      ? Promise.resolve()
      : new Promise((resolveFlush) => {
          try {
            stream.write('', () => resolveFlush());
          } catch {
            resolveFlush();
          }
        });
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
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
