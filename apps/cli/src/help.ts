/** Help is pure data and rendering: no environment, configuration, backend or connection reads. */
import { DEFAULT_TIMEOUT_MS } from '@raphael/client';
import { DEGRADED_CONSTRUCTS, DEGRADED_CONSTRUCT_DESCRIPTIONS } from '@raphael/content';
import { API_ERROR_CODES, ApiErrorDetails } from '@raphael/contracts';
import { SENDABLE_API_KEY_RULE } from '@raphael/contracts/connection';

import type { CommandDefinition, CommandExample } from './shared/command.ts';
import {
  CLI_ERROR_CODES,
  SERVER_CODE_MEANINGS,
  errorCodeList,
  type ErrorCodeEntry,
} from './shared/error-codes.ts';
import { EXIT_CODES, EXIT_FAILURE, EXIT_UNKNOWN, SERVER_CODE_EXIT } from './shared/exit.ts';
import { HELP_RULES } from './shared/help-rules.ts';
import { STATE_WORDS } from './shared/state-words.ts';
import { WARNING_CODES } from './shared/success.ts';
import { TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS } from './shared/timeout.ts';
import {
  CLIENT_API_KEY_VARIABLE,
  CLIENT_ENDPOINT_VARIABLE,
  SERVER_API_KEY_VARIABLE,
  SERVER_KEY_FILE_RECIPE,
  TIMEOUT_VARIABLE,
} from './shared/variables.ts';

export interface HelpTopic {
  readonly name: string;
  readonly summary: string;
  readonly body: readonly string[];
  readonly examples: readonly CommandExample[];
}

/** `a, b, c or d`. */
const listedOr = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;

const exitCodeLines = EXIT_CODES.map(
  ({ code, meaning }) => `  ${String(code).padEnd(4)} ${meaning}`,
).join('\n');

const REFERENCE_SUMMARY = 'All command pages and topics in one stream.';

/** Every code a failure can carry, one row each: the code, then its exit codes and meaning. */
const errorCodeRows = (() => {
  const width = Math.max(
    ...[...API_ERROR_CODES, ...Object.keys(CLI_ERROR_CODES)].map((code) => code.length),
  );
  const row = (code: string, text: string): string => `  ${code.padEnd(width)}  ${text}`;
  return {
    server: API_ERROR_CODES.map((code) => {
      const exit = SERVER_CODE_EXIT[code];
      return row(
        code,
        `${
          exit === 'server_fault'
            ? `Exit ${EXIT_FAILURE}, or ${EXIT_UNKNOWN} when a write may have been applied.`
            : `Exit ${exit}.`
        } ${SERVER_CODE_MEANINGS[code]}`,
      );
    }).join('\n'),
    cli: Object.entries(CLI_ERROR_CODES)
      .map(([code, { exits, meaning }]: [string, ErrorCodeEntry]) =>
        row(code, `Exit ${listedOr(exits.map(String))}. ${meaning}`),
      )
      .join('\n'),
  };
})();

/** Each failure category with the exit codes it names: `failed for 1, ..., interrupted for 130 and 143`. */
const CATEGORY_WORDS = [
  ...new Set(EXIT_CODES.flatMap(({ category }) => (category === 'ok' ? [] : [category]))),
]
  .map((category) => {
    const codes = EXIT_CODES.filter((entry) => entry.category === category).map(({ code }) =>
      String(code),
    );
    return `${category} for ${codes.length <= 1 ? (codes[0] ?? '') : `${codes.slice(0, -1).join(', ')} and ${codes.at(-1) ?? ''}`}`;
  })
  .join(', ');

/** The fields a server's failure details may carry, as the contract's schema declares them. */
const DETAIL_FIELDS = Object.keys(ApiErrorDetails.fields);

export const ROOT_EXAMPLES: readonly CommandExample[] = [
  { argv: ['login'], description: 'Connect using the server address and key.' },
  {
    argv: ['create', 'resource.note', '/work/first-note', '--body', 'My first note'],
    description: 'Write a note in the initial work area.',
  },
  { argv: ['list', '/'], description: 'Read the top level.' },
];

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    name: 'addressing',
    summary: 'Paths, ids, slugs, containment and field limits.',
    body: [
      'Paths are absolute: /work/raphael/backend. The root is /. For commands that address one item, use a path or --id, never both. List and search may mix paths and repeated --id. The root can be listed and searched, but cannot be read or changed as an item. A path changes when an item or an ancestor moves or changes slug; its positive integer id stays the same. --id is repeatable only on list and search.',
      HELP_RULES.types,
      HELP_RULES.containment,
      HELP_RULES.slug,
      'Create with a full path, or with --parent-id and --slug. The final path segment is the new slug. Parent items must already exist. Renaming a title does not change the slug; use `update --slug` to change its address. Archive retains the item and reserves its slug. There is no delete command.',
      HELP_RULES.fields,
      HELP_RULES.paging,
      `For list: ${HELP_RULES.ordering} Search orders by relevance and does not accept --order-by.`,
      HELP_RULES.filter,
    ],
    examples: [
      { argv: ['get', '/work/raphael'] },
      { argv: ['get', '--id', '42'] },
      {
        argv: ['create', 'project', '--parent-id', '42', '--slug', 'raphael', '--title', 'Raphael'],
      },
    ],
  },
  {
    name: 'content',
    summary: 'Note bodies, files, stdin and Markdown conversion.',
    body: [
      `Create a note with \`create resource.note\`. ${HELP_RULES.derivedTitle} A title must still be available when the body is empty.`,
      "Body text is literal unless it starts with @: `--body @draft.md` reads a file, and `--body @-` reads stdin. Use --body-literal to keep a leading @ as text. A body read from stdin or a file that is empty or only whitespace is refused. To explicitly clear an existing body use update with `--body ''` and --revision. A pipe is read only when `--body @-` is given; on a terminal, @- says how to finish typing.",
      HELP_RULES.dashValues,
      'Metadata and filters accept inline JSON or @file, but not @-. Metadata is set once at create and cannot be updated. File and stdin reads are bounded, and invalid independent arguments are refused before reading body content.',
      HELP_RULES.content,
      `Markdown the stored document cannot represent is not stored as written: ${DEGRADED_CONSTRUCTS.map((construct) => `${DEGRADED_CONSTRUCT_DESCRIPTIONS[construct].name} is ${DEGRADED_CONSTRUCT_DESCRIPTIONS[construct].outcome}`).join('; ')}. When that happens, create and update warn on standard error and in warnings[]; --strict refuses the body instead, with exit 2. Escaping, joined lines and other rewrites that keep the meaning are not reported. Text such as List<String> is an HTML tag by CommonMark's rules; put it in backticks to keep it as code.`,
      'A body that is a TipTap JSON document must be sent with `--body-format tiptap`; sent as Markdown it is refused. To keep JSON as note text, put it in a fenced code block. Markdown output is a best-effort export of the stored document; use `--json --return-format tiptap` to read its structured body. --return-format requires --json; it controls the response, while --body-format controls submitted content.',
    ],
    examples: [
      { argv: ['create', 'resource.note', '/work/idea', '--body', '# An idea'] },
      { argv: ['get', '/work/idea', '--json', '--return-format', 'tiptap'] },
      { argv: ['update', '/work/idea', '--body', '', '--revision', '3'] },
    ],
  },
  {
    name: 'revisions',
    summary: 'Safe writes, conflicts, archives and unknown outcomes.',
    body: [
      'A revision is a positive integer returned when an item is read. Update, move, archive and restore check it before changing anything. Pass --revision to apply a change only to the version you read. For changes other than body replacements, omitting --revision makes the CLI read the current revision first and pin the subsequent write to that same id. Body replacements require an explicit --revision.',
      'Exit 4 means stored state prevented the change and nothing was applied. For a revision conflict, run get again, compare your intended change with the current item, then retry with its new revision. Do not blindly replace the revision and overwrite a concurrent edit. A slug conflict can also be caused by an archived item: choose another slug or restore the existing item.',
      'Archiving an item hides it and its descendants from ordinary lists and search. --include-archived includes active and archived items. Archived items retain their slugs. Restore removes only the cause archive put on the item itself; an archived ancestor, or a cause set by something other than archive, keeps the item archived. Read it again and restore the blocking ancestor when appropriate.',
      'Exit 7 means a write was sent and its outcome is unknown. Read the item to reconcile before deciding whether to try again. For an uncertain create, read the intended path; retrying create may encounter your own slug collision. Exit 6 means retrying may work and the change was not applied.',
    ],
    examples: [
      { argv: ['get', '/work/idea', '--json'] },
      { argv: ['update', '/work/idea', '--title', 'Revised idea', '--revision', '3'] },
      { argv: ['list', '/work', '--include-archived'] },
    ],
  },
  {
    name: 'output',
    summary: 'Text results, JSON envelopes, paging and diagnostics.',
    body: [
      `Standard output holds results only. Without --json, lists, search and favorites print one row per item: id, type, state, path and title, in columns padded to the widest value on the page. State is ${listedOr(Object.values(STATE_WORDS))}, and comes before the title, which is always last. A title, description or tag that could be misread, such as one holding a quote, a backslash or a control character, is printed as a JSON string. A header line is printed only on a terminal. A write prints a line naming the item, then its path, and its revision when it has one; a write that changed nothing says Unchanged; get prints every field, including the update time. List order defaults to slug ascending; use \`list --order-by updatedAt:desc\` for recent changes. Search orders by relevance and does not accept --order-by. Bodies are printed as Markdown by default.`,
      'With --json, a successful command prints exactly one document: {"ok":true,"command":"get",...data}. Full-item reads and writes use entity; move, archive and restore use node; lists and favorites use items; search uses items[].node. These are machine field names. Items include path and updatedAt, an ISO 8601 UTC time such as 2026-10-19T10:42:07.123Z; text output prints the same string. No createdAt field is exposed. Update, move, archive, restore, favorite and unfavorite include changed; false means success without a change and without a revision bump. Move and update also report previousPath, the path before the change; text output prints it as was: only when the path changed. Favorite commands report `nodeId`, `isFavorite` and `node`, which is null when unfavorite names an id that does not exist. Path reports path.',
      `Paged results include page with skip, limit, hasMore, nextSkip and archivedLeftOut, which is true when archived items were left out of the answer. The result footer and runnable next-page command go to standard error, never standard output. Empty-result notes, warnings, hints, prompts and failures also go to standard error. Warnings appear in warnings[] on JSON successes as {code, message}, plus constructs for markdown_degraded. Codes: ${Object.entries(
        WARNING_CODES,
      )
        .map(([code, meaning]) => `${code}: ${meaning}`)
        .join(' ')} Closing a pipe early does not turn a completed command into a failure.`,
      `JSON failures leave stdout empty and print exactly one document to stderr: {"ok":false,"command":"get","error":{...}}. The only other text stderr can then hold is for a person at a terminal: login's prompts, and the note that --body @- is reading from one. command is the command as typed (help for every help form), or null when none was recognized. error always has code, category, message, hint, exitCode, applied and retryable. Optional fields include status, field, target, serverMessage, details, and connection {endpoint, source, configFile} once a connection was resolved. category is the word for exitCode: ${CATEGORY_WORDS}. code is a server code or one of this CLI's: ${Object.keys(CLI_ERROR_CODES).join(', ')}; \`raphael help exit-codes\` gives each one's exit codes and meaning. For a server's answer, details carries what the server reported, each field optional: ${DETAIL_FIELDS.join(', ')}; blocking is {id, type}. For incompatible_protocol, details is {serverProtocol, serverVersion, cliProtocol, cliVersion}, with null for what the server did not say, and serverCode when its answer carried a code of its own. applied is false when no change was applied, true when known applied, and null when unknown. Retry decisions must consider exitCode and applied; do not blindly retry an uncertain write. The JSON envelope and exit-code meanings are stable within a major version.`,
      'help --json prints one document to stdout: {"ok":true,"command":"help",...}. For the root page and for reference it has commands, topics, examples, exitCodes and errorCodes; for a command, definition; for a topic, topic. A definition has name, summary, group, writes, usage, behavior, options, examples, prints and next, and may have constraints and seeAlso. Each option has name, type and description, and may have short, multiple, whole {min, max}, valueName, default and constraint. A topic has name, summary, body and examples. Each errorCodes entry has code, source, exitCodes, categories and meaning.',
      'For text write failures, the state line distinguishes Nothing was changed., The change was not sent., and The change may or may not have been applied. Set RAPHAEL_DEBUG=1 to include diagnostic stacks. Keep stdout for results when scripting.',
      'On standard error, a line that starts with hint: is a runnable next step, and a line that starts with warning: is something a success did not do as asked. Other lines are information only, such as Showing 1-3. or Nothing changed: it was already archived. A note that also suggests a command puts that command on its own hint: line. A hint that is a command quotes all of it, as in hint: Run "raphael favorites" to see your favorites. or hint: Did you mean "raphael list /work"?',
      HELP_RULES.archiveCauses,
      HELP_RULES.paging,
      `For list: ${HELP_RULES.ordering} Search orders by relevance and does not accept --order-by.`,
    ],
    examples: [
      { argv: ['list', '/', '--json'] },
      { argv: ['list', '/', '--json', '--order-by', 'updatedAt:desc'] },
      { argv: ['get', '--id', '42', '--json', '--return-format', 'tiptap'] },
    ],
  },
  {
    name: 'connecting',
    summary: 'Start a local server and connect a client.',
    body: [
      `Run a server: put ${SERVER_API_KEY_VARIABLE}=<key> in an owner-only .env file, made with \`${SERVER_KEY_FILE_RECIPE}\`, then run \`raphael server serve\` in that directory. With --config, the .env beside the configuration file is read instead. An environment value wins over .env, and an empty one is refused rather than ignored. The server listens on http://127.0.0.1:3000 unless --host, --port or the configuration file say otherwise, and prints the address and the login command when it starts. It never reads your saved login.`,
      `Connect: in another terminal run \`raphael login http://127.0.0.1:3000\` and enter the same key. Login verifies the address and key before saving them with owner-only permissions to $XDG_CONFIG_HOME/raphael/config.json, or ~/.config/raphael/config.json. Without a terminal, pipe the key: \`printf '%s\\n' "$KEY" | raphael login <address> --api-key-stdin\`. Logging in again replaces the saved login; \`raphael logout\` removes it.`,
      `Check: \`raphael status\` reports the server, where its address and key came from, and the protocol and release of each side. Run it first in a script; exit 0 means remote commands can work.`,
      `Without a saved login, set ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} together. Both or neither: a partial pair is refused, an empty variable counts as unset, and a complete pair overrides the saved login. ${CLIENT_API_KEY_VARIABLE} is the server's ${SERVER_API_KEY_VARIABLE}; clients do not read .env, and the server does not read ${CLIENT_API_KEY_VARIABLE}. A key must be ${SENDABLE_API_KEY_RULE}.`,
      `${TIMEOUT_VARIABLE} sets the request timeout in whole seconds, from ${TIMEOUT_MIN_SECONDS} to ${TIMEOUT_MAX_SECONDS}; the default is ${DEFAULT_TIMEOUT_MS / 1000} seconds. Exit 5 means the connection needs attention: the error names the address and where it came from, and the hint says what to change. Exit 6 means the server could not be reached and nothing was applied. Read \`raphael help exit-codes\` before retrying a failed write.`,
    ],
    examples: [
      { argv: ['server', 'serve'] },
      { argv: ['login', 'http://127.0.0.1:3000'] },
      { argv: ['status', '--json'] },
    ],
  },
  {
    name: 'exit-codes',
    summary: 'Choose recovery from the process exit code.',
    body: [
      exitCodeLines,
      'For exit 7 reconcile by reading before retrying. SIGINT and SIGTERM retain their conventional codes; a write interrupted after sending may still have been applied. JSON failures also report applied and retryable.',
      "Every failure carries a stable identifier in error.code. A failure the server answered keeps the server's code; every other failure carries one of this CLI's codes. A code listed nowhere here comes from a newer server, and its exitCode still applies. Choose a recovery from exitCode; use the code to tell causes apart.",
      `Server codes:\n${errorCodeRows.server}`,
      `Codes from this CLI:\n${errorCodeRows.cli}`,
    ],
    examples: [
      { argv: ['get', '/work', '--json'] },
      { argv: ['help', 'revisions'] },
      { argv: ['help', 'output'] },
    ],
  },
];

/** Shell-safe display that preserves every argv value, including an explicit empty string. */
export const renderExample = (example: CommandExample): string =>
  `raphael ${example.argv
    .map((value) =>
      /^[\w./:@=,+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`,
    )
    .join(' ')}`;

/**
 * Rendered text help is filled to this width, so a page reads in an 80-column terminal and in an
 * agent's tool output without lines running on. `help --json` carries the same strings unwrapped.
 */
export const HELP_WIDTH = 80;

/** Option descriptions sit under their names: four columns in from where `--` starts. */
const OPTION_INDENT = ' '.repeat(10);

/**
 * The words of some prose, with every span that is copied as written kept whole: a `code` span in
 * backticks, a "quoted" span, and a {JSON, shape}. A command or a JSON value broken across two
 * lines no longer runs when it is pasted, so such a span is never split, even when it is wider than
 * the page; it then gets a line of its own. Spaces inside a kept span are kept exactly.
 */
const atomsOf = (text: string): string[] => {
  const atoms: string[] = [];
  let code = false;
  let quoted = false;
  let braces = 0;
  for (const word of text.split(' ')) {
    if (code || quoted || braces > 0) atoms[atoms.length - 1] += ` ${word}`;
    else if (word !== '') atoms.push(word);
    for (const character of word) {
      if (character === '`') code = !code;
      else if (code) continue;
      else if (character === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (character === '{') braces += 1;
      else if (character === '}') braces = Math.max(0, braces - 1);
    }
  }
  return atoms;
};

/**
 * Fill words to the help width: the first line starts with `first`, every later line with `rest`.
 * A word is moved to the next line only when the line already holds one, so nothing is ever lost.
 */
const fillAtoms = (atoms: readonly string[], first: string, rest: string): string => {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const atom of atoms) {
    if (!empty && line.length + 1 + atom.length > HELP_WIDTH) {
      lines.push(line);
      line = `${rest}${atom}`;
    } else line = empty ? `${line}${atom}` : `${line} ${atom}`;
    empty = false;
  }
  lines.push(line);
  return lines.join('\n');
};

const fill = (text: string, first: string, rest: string): string =>
  text
    .split('\n')
    .map((line) => fillAtoms(atomsOf(line), first, rest))
    .join('\n');

/**
 * Fill prose that may carry its own layout, line by line. A line keeps its leading indent, and a
 * row such as `  0    Done.` or `  list               List children.` continues under its second
 * column, so wrapped rows still read as a table.
 */
const paragraph = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const lead = /^ *(?:\S+ {2,})?/u.exec(line)?.[0] ?? '';
      return fill(line.slice(lead.length), lead, ' '.repeat(lead.length));
    })
    .join('\n');

/** A row of a two-column list: the name, then text that continues under its own column. */
const row = (name: string, text: string): string =>
  fill(text, `  ${name.padEnd(18)} `, ' '.repeat(21));

/** Example command lines are never wrapped: they are copied and run as they are. */
const exampleLines = (examples: readonly CommandExample[]): string =>
  examples
    .map(
      (example) =>
        `  ${renderExample(example)}${example.description ? `\n${fill(example.description, '    ', '    ')}` : ''}`,
    )
    .join('\n');

export const renderCommandHelp = (definition: CommandDefinition): string => {
  const options = definition.options.map((option) => {
    const flag = `${option.short ? `-${option.short}, ` : '    '}--${option.name}${option.type === 'string' ? ` <${option.valueName ?? 'value'}>` : ''}`;
    const details = [
      option.description,
      option.multiple ? 'Repeatable.' : undefined,
      option.type === 'boolean' || option.default === undefined
        ? undefined
        : `Default: ${String(option.default)}.`,
      option.constraint,
    ]
      .filter(Boolean)
      .join(' ');
    return `  ${flag}\n${fill(details, OPTION_INDENT, OPTION_INDENT)}`;
  });
  return [
    // Usage lines are never wrapped: each is one command shape.
    definition.usage
      .map(
        (line, index) =>
          `${index === 0 ? 'Usage: ' : '       '}${line.startsWith('raphael ') ? line : `raphael ${line}`}`,
      )
      .join('\n'),
    paragraph(definition.summary),
    ...definition.behavior.map(paragraph),
    ...(definition.constraints?.length
      ? [`Rules:\n${definition.constraints.map((line) => fill(line, '  ', '    ')).join('\n')}`]
      : []),
    ...(options.length ? [`Options:\n${options.join('\n')}`] : []),
    `Examples:\n${exampleLines(definition.examples)}`,
    `Prints:\n${fill(definition.prints, '  ', '  ')}`,
    `Next: ${definition.next}`,
    ...(definition.seeAlso?.length
      ? [
          fillAtoms(
            definition.seeAlso.map(
              (name, index, all) => `raphael help ${name}${index === all.length - 1 ? '' : ';'}`,
            ),
            'See also: ',
            '          ',
          ),
        ]
      : []),
  ].join('\n\n');
};

export const renderRootHelp = (definitions: readonly CommandDefinition[]): string =>
  [
    'raphael - an actionable second brain for agents',
    'Usage: raphael <command> [options]',
    [
      'Start here:',
      ...[
        `Make a private key file: \`${SERVER_KEY_FILE_RECIPE}\``,
        'Run `raphael server serve` in that directory; keep that terminal open.',
        'In another terminal run `raphael login http://127.0.0.1:3000` and enter the key from .env.',
        'Run `raphael status`, then `raphael list /`.',
        "Run `raphael create resource.note /work/first-note --body 'My first note'`.",
      ].map((step, index) => fill(step, `  ${index + 1}. `, '     ')),
      fill(
        'Already have a server? Start at step 3 with its address and key. See `raphael help connecting`.',
        '  ',
        '  ',
      ),
    ].join('\n'),
    ...(['Read', 'Write', 'Setup'] as const).map(
      (group) =>
        `${group}:\n${definitions
          .filter((definition) => definition.group === group)
          .map((definition) => row(definition.name, definition.summary))
          .join('\n')}`,
    ),
    `What things are:\n${[
      'An area holds ongoing work. A project holds work with an outcome. A note holds content.',
      HELP_RULES.types,
      HELP_RULES.containment,
      'Address an item by absolute path or stable id; a revision protects a write from concurrent edits.',
    ]
      .map((text) => fill(text, '  ', '    '))
      .join('\n')}`,
    `Topics:\n${[
      ...HELP_TOPICS.map((topic) => row(topic.name, topic.summary)),
      row('reference', REFERENCE_SUMMARY),
      fill(
        'Use `raphael help <command-or-topic>`, or `raphael <command> --help`. `raphael help --json` prints machine-readable definitions.',
        '  ',
        '  ',
      ),
    ].join('\n')}`,
    `Examples:\n${exampleLines(ROOT_EXAMPLES)}`,
    'Options:\n  -h, --help    Show help.\n      --version Show the version.',
    `Exit codes:\n${paragraph(exitCodeLines)}`,
  ].join('\n\n');

export const renderTopicHelp = (name: string): string | undefined => {
  const topic = HELP_TOPICS.find((candidate) => candidate.name === name);
  return topic === undefined
    ? undefined
    : [
        fill(`raphael help ${topic.name} - ${topic.summary}`, '', '  '),
        ...topic.body.map(paragraph),
        `Examples:\n${exampleLines(topic.examples)}`,
        'Next: raphael help reference',
      ].join('\n\n');
};

export const renderReferenceHelp = (definitions: readonly CommandDefinition[]): string =>
  [
    renderRootHelp(definitions),
    ...definitions.map(renderCommandHelp),
    ...HELP_TOPICS.map((topic) => renderTopicHelp(topic.name)),
  ].join('\n\n---\n\n');

/** Definition members only this CLI's own code reads: failure wording's flag map and its own flags. */
const INTERNAL_MEMBERS: ReadonlySet<string> = new Set(['fieldFlags', 'verifiesServer']);
const INTERNAL_OPTION_MEMBERS: ReadonlySet<string> = new Set(['changes', 'example', 'leadingDash']);

const withoutMembers = (value: object, members: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !members.has(key)));

/** A definition as machine help publishes it: what help documents, and nothing only the CLI reads. */
const publishedDefinition = (definition: CommandDefinition): Record<string, unknown> => ({
  ...withoutMembers(definition, INTERNAL_MEMBERS),
  options: definition.options.map((option) => withoutMembers(option, INTERNAL_OPTION_MEMBERS)),
});

/**
 * The data of the `help --json` document, beside `ok` and `command`: everything for the root page
 * and for `reference`, `definition` for a command and `topic` for a topic. `name` is one the text
 * renderer already accepted.
 */
export const renderJsonHelp = (
  definitions: readonly CommandDefinition[],
  name: string,
): Readonly<Record<string, unknown>> => {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (definition !== undefined) return { definition: publishedDefinition(definition) };
  const topic = HELP_TOPICS.find((candidate) => candidate.name === name);
  if (topic !== undefined) return { topic };
  return {
    commands: definitions.map(publishedDefinition),
    // Its body is every other page, which the document already carries as commands and topics.
    topics: [
      ...HELP_TOPICS,
      { name: 'reference', summary: REFERENCE_SUMMARY, body: [], examples: [] },
    ],
    examples: ROOT_EXAMPLES,
    exitCodes: EXIT_CODES,
    errorCodes: errorCodeList(),
  };
};
