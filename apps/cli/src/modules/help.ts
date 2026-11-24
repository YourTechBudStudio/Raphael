import { HELP_OPTION, JSON_OPTION, type CommandDefinition } from '../shared/command.ts';

export const VERSION_DEFINITION: CommandDefinition = {
  name: 'version',
  summary: 'Print the installed Raphael release.',
  group: 'Setup',
  writes: false,
  usage: ['raphael version [--json]', 'raphael --version [--json]'],
  behavior: [
    'Works offline: reads no configuration and contacts no server.',
    'To compare with a server, run `raphael status`, which reports both sides.',
  ],
  options: [JSON_OPTION, HELP_OPTION],
  examples: [{ argv: ['version'] }, { argv: ['version', '--json'] }, { argv: ['--version'] }],
  prints: 'The bare release number. JSON has version and protocolVersion.',
  next: 'raphael status',
  fieldFlags: {},
};

export const HELP_DEFINITION: CommandDefinition = {
  name: 'help',
  summary: 'Read command help and cross-command guidance.',
  group: 'Read',
  writes: false,
  usage: ['raphael help [<command> | <topic>] [--json]'],
  behavior: [
    'Commands take precedence over topics. Help works without a connection or saved login. `raphael help <x>`, `raphael <x> --help` and `raphael <x> -h` print the same page, as text or, with --json, as the same document.',
    '`raphael help reference` prints every page in one stream.',
  ],
  options: [JSON_OPTION, HELP_OPTION],
  examples: [
    { argv: ['help', 'create'] },
    { argv: ['help', 'reference'] },
    { argv: ['help', '--json', 'search'] },
  ],
  prints:
    'Help text. With --json, one document {"ok":true,"command":"help",...}: commands, topics, examples, exitCodes and errorCodes for the root page and reference, definition for a command, topic for a topic. `raphael help output` describes it.',
  next: 'raphael help reference',
  fieldFlags: {},
};
