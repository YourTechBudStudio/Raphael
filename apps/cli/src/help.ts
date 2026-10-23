/** Help is pure data and rendering: no environment, configuration, backend or connection reads. */
import { DEFAULT_TIMEOUT_MS } from '@raphael/client';
import { DEGRADED_CONSTRUCTS, DEGRADED_CONSTRUCT_DESCRIPTIONS } from '@raphael/content';
import { API_ERROR_CODES } from '@raphael/contracts';
import { SENDABLE_API_KEY_RULE } from '@raphael/contracts/connection';

import type { CommandDefinition, CommandExample } from './shared/command.ts';
import { EXIT_CODES } from './shared/exit.ts';
import { HELP_RULES } from './shared/help-rules.ts';
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

const exitCodeLines = EXIT_CODES.map(
  ({ code, meaning }) => `  ${String(code).padEnd(4)} ${meaning}`,
).join('\n');

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
      'Create with a full path, or with --parent-id and --slug. The final path segment is the new slug. Parent items must already exist. Renaming a title does not change the slug; use update --slug to change its address. Archive retains the item and reserves its slug. There is no delete command.',
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
      'Create a note with create resource.note. Give --title, or let the first non-empty line of the body (then description) supply it. A title must still be available when the body is empty.',
      "Body text is literal unless it starts with @: --body @draft.md reads a file, and --body @- reads stdin. Use --body-literal to keep a leading @ as text. Empty stdin is refused. To explicitly clear an existing body use update with --body '' and --revision. A pipe is read only when --body @- is given; on a terminal, @- says how to finish typing.",
      'Metadata and filters accept inline JSON or @file, but not @-. Metadata is set once at create and cannot be updated. File and stdin reads are bounded, and invalid independent arguments are refused before reading body content.',
      HELP_RULES.content,
      `Markdown the stored document cannot represent is kept as text: ${DEGRADED_CONSTRUCTS.map((construct) => `${DEGRADED_CONSTRUCT_DESCRIPTIONS[construct].name} is kept as ${DEGRADED_CONSTRUCT_DESCRIPTIONS[construct].kept}`).join('; ')}. When that happens, create and update warn on standard error and in warnings[]; --strict refuses the body instead, with exit 2. Escaping, joined lines and other rewrites that keep the meaning are not reported. Text such as List<String> is an HTML tag by CommonMark's rules; put it in backticks to keep it as code.`,
      'A body that is a TipTap JSON document must be sent with --body-format tiptap; sent as Markdown it is refused. To keep JSON as note text, put it in a fenced code block. Markdown output is a best-effort export of the stored document; use --json --return-format tiptap to read its structured body. --return-format requires --json; it controls the response, while --body-format controls submitted content.',
    ],
    examples: [
      { argv: ['create', 'resource.note', '/work/idea', '--body', '# An idea'] },
      { argv: ['get', '/work/idea', '--json', '--return-format', 'tiptap'] },
      { argv: ['update', '/work/idea', '--body', '', '--revision', '3'] },
    ],
  },
  {
    name: 'revisions',
    summary: 'Safe writes, conflicts, archives and uncertain outcomes.',
    body: [
      'A revision is a positive integer returned when an item is read. Update, move, archive and restore check it before changing anything. Pass --revision to apply a change only to the version you read. For changes other than body replacements, omitting --revision makes the CLI read the current revision first and pin the subsequent write to that same id. Body replacements require an explicit --revision.',
      'Exit 4 means stored state prevented the change and nothing was applied. For a revision conflict, run get again, compare your intended change with the current item, then retry with its new revision. Do not blindly replace the revision and overwrite a concurrent edit. A slug conflict can also be caused by an archived item: choose another slug or restore the existing item.',
      'Archiving an item hides it and its descendants from ordinary lists and search. --include-archived includes active and archived items. Archived items retain their slugs. Restoring removes your direct archive cause; an archived ancestor or another cause may keep the item archived. Read it again and restore the blocking ancestor when appropriate.',
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
      'Standard output holds results only. Without --json, lists, search and favorites print one row per item: id, type, state, path and title, in columns padded to the widest value on the page. State is -, active, archived or active,archived, and comes before the title, which is always last. A header line is printed only on a terminal. A write prints a line naming the item, then its path, and its revision when it has one; a write that changed nothing says Unchanged; get prints every field, including the update time. List order defaults to slug ascending; use list --order-by updatedAt:desc for recent changes. Search orders by relevance and does not accept --order-by. Bodies are printed as Markdown by default.',
      'With --json, a successful command prints exactly one document: {"ok":true,"command":"get",...data}. Full-item reads and writes use entity; move, archive and restore use node; lists and favorites use items; search uses items[].node. These are machine field names. Items include path and updatedAt, an ISO 8601 UTC time such as 2026-10-19T10:42:07.123Z; text output prints the same string. No createdAt field is exposed. Update, move, archive, restore, favorite and unfavorite include changed; false means success without a change and without a revision bump. Move also reports previousPath. Favorite commands report `nodeId`, `isFavorite` and `node`, which is null when unfavorite names an id that does not exist. Path reports path.',
      `Paged results include page with skip, limit, hasMore, nextSkip and archivedLeftOut, which is true when archived items were left out of the answer. The result footer and runnable next-page command go to standard error, never standard output. Empty-result notes, warnings, hints, prompts and failures also go to standard error. Warnings appear in warnings[] on JSON successes as {code, message}, plus constructs for markdown_degraded. Codes: ${Object.entries(
        WARNING_CODES,
      )
        .map(([code, meaning]) => `${code}: ${meaning}`)
        .join(' ')} Closing a pipe early does not turn a completed command into a failure.`,
      'JSON failures leave stdout empty and print exactly one document to stderr: {"ok":false,"error":{"code":...,"category":...,"message":...,"hint":...,"exitCode":...,"applied":...,"retryable":...}}. Optional fields include status, field, target, serverMessage, details, and connection {endpoint, source, configFile} once a connection was resolved. applied is false when no change was applied, true when known applied, and null when unknown. Retry decisions must consider exitCode and applied; do not blindly retry an uncertain write. The JSON envelope and exit-code meanings are stable within a major version.',
      'For text write failures, the state line distinguishes Nothing was changed., The change was not sent., and The change may or may not have been applied. Set RAPHAEL_DEBUG=1 to include diagnostic stacks. Keep stdout for results when scripting.',
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
      `Run a server: put ${SERVER_API_KEY_VARIABLE}=<key> in an owner-only .env file, made with ${SERVER_KEY_FILE_RECIPE}, then run raphael server serve in that directory. With --config, the .env beside the configuration file is read instead. An environment value wins over .env, and an empty one is refused rather than ignored. The server listens on http://127.0.0.1:3000 unless --host, --port or the configuration file say otherwise, and prints the address and the login command when it starts. It never reads your saved login.`,
      `Connect: in another terminal run raphael login http://127.0.0.1:3000 and enter the same key. Login verifies the address and key before saving them with owner-only permissions to $XDG_CONFIG_HOME/raphael/config.json, or ~/.config/raphael/config.json. Without a terminal, pipe the key: printf '%s\\n' "$KEY" | raphael login <address> --api-key-stdin. Logging in again replaces the saved login; raphael logout removes it.`,
      `Check: raphael status reports the server, where its address and key came from, and the protocol and release of each side. Run it first in a script; exit 0 means remote commands can work.`,
      `Without a saved login, set ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} together. Both or neither: a partial pair is refused, an empty variable counts as unset, and a complete pair overrides the saved login. ${CLIENT_API_KEY_VARIABLE} is the server's ${SERVER_API_KEY_VARIABLE}; clients do not read .env, and the server does not read ${CLIENT_API_KEY_VARIABLE}. A key must be ${SENDABLE_API_KEY_RULE}.`,
      `${TIMEOUT_VARIABLE} sets the request timeout in whole seconds, from ${TIMEOUT_MIN_SECONDS} to ${TIMEOUT_MAX_SECONDS}; the default is ${DEFAULT_TIMEOUT_MS / 1000} seconds. Exit 5 means the connection needs attention: the error names the address and where it came from, and the hint says what to change. Exit 6 means the server could not be reached and nothing was applied. Read help exit-codes before retrying a failed write.`,
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
      `Server error codes: ${API_ERROR_CODES.join(', ')}. Machine codes are stable identifiers; use exitCode to choose a recovery category.`,
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

const exampleLines = (examples: readonly CommandExample[]): string =>
  examples
    .map(
      (example) =>
        `  ${renderExample(example)}${example.description ? `\n    ${example.description}` : ''}`,
    )
    .join('\n');

export const renderCommandHelp = (definition: CommandDefinition): string => {
  const options = definition.options.map((option) => {
    const flag = `${option.short ? `-${option.short}, ` : '    '}--${option.name}${option.type === 'string' ? ` <${option.valueName ?? 'value'}>` : ''}`;
    const details = [
      option.description,
      option.multiple ? 'Repeatable.' : undefined,
      option.default === undefined ? undefined : `Default: ${String(option.default)}.`,
      option.constraint,
    ]
      .filter(Boolean)
      .join(' ');
    return `  ${flag}\n      ${details}`;
  });
  return [
    definition.usage
      .map(
        (line, index) =>
          `${index === 0 ? 'Usage: ' : '       '}${line.startsWith('raphael ') ? line : `raphael ${line}`}`,
      )
      .join('\n'),
    definition.summary,
    ...definition.behavior,
    ...(definition.constraints?.length
      ? [`Rules:\n${definition.constraints.map((line) => `  ${line}`).join('\n')}`]
      : []),
    ...(options.length ? [`Options:\n${options.join('\n')}`] : []),
    `Examples:\n${exampleLines(definition.examples)}`,
    `Prints:\n  ${definition.prints}`,
    `Next: ${definition.next}`,
    ...(definition.seeAlso?.length
      ? [`See also: ${definition.seeAlso.map((name) => `raphael help ${name}`).join('; ')}`]
      : []),
  ].join('\n\n');
};

export const renderRootHelp = (definitions: readonly CommandDefinition[]): string =>
  [
    'raphael - an actionable second brain for agents',
    'Usage: raphael <command> [options]',
    [
      'Start here:',
      `  1. Make a private key file: ${SERVER_KEY_FILE_RECIPE}`,
      '  2. Run raphael server serve in that directory; keep that terminal open.',
      '  3. In another terminal run raphael login http://127.0.0.1:3000 and enter the key from .env.',
      '  4. Run raphael status, then raphael list /.',
      "  5. Run raphael create resource.note /work/first-note --body 'My first note'.",
      '  Already have a server? Start at step 3 with its address and key. See raphael help connecting.',
    ].join('\n'),
    ...(['Read', 'Write', 'Setup'] as const).map(
      (group) =>
        `${group}:\n${definitions
          .filter((definition) => definition.group === group)
          .map((definition) => `  ${definition.name.padEnd(18)} ${definition.summary}`)
          .join('\n')}`,
    ),
    `What things are:\n  An area holds ongoing work. A project holds work with an outcome. A note holds content.\n  ${HELP_RULES.types}\n${HELP_RULES.containment
      .split('\n')
      .map((line) => `  ${line}`)
      .join(
        '\n',
      )}\n  Address an item by absolute path or stable id; a revision protects a write from concurrent edits.`,
    `Topics:\n${HELP_TOPICS.map((topic) => `  ${topic.name.padEnd(18)} ${topic.summary}`).join('\n')}\n  reference          All command pages and topics in one stream.\n  Use raphael help <command-or-topic>, or raphael <command> --help.\n  raphael help --json prints machine-readable definitions.`,
    `Examples:\n${exampleLines(ROOT_EXAMPLES)}`,
    'Options:\n  -h, --help    Show help.\n      --version Show the version.',
    `Exit codes:\n${exitCodeLines}`,
  ].join('\n\n');

export const renderTopicHelp = (name: string): string | undefined => {
  const topic = HELP_TOPICS.find((candidate) => candidate.name === name);
  return topic === undefined
    ? undefined
    : [
        `raphael help ${topic.name} - ${topic.summary}`,
        ...topic.body,
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

export const renderJsonHelp = (
  definitions: readonly CommandDefinition[],
  command?: string,
): object => {
  if (command !== undefined && command !== 'reference') {
    return (
      definitions.find((definition) => definition.name === command) ??
      HELP_TOPICS.find((topic) => topic.name === command) ??
      {}
    );
  }
  return {
    commands: definitions,
    topics: [
      ...HELP_TOPICS,
      { name: 'reference', summary: 'All command pages and topics in one stream.', examples: [] },
    ],
    examples: ROOT_EXAMPLES,
    exitCodes: EXIT_CODES,
  };
};
