import type { CommandDefinition } from '../shared/command.ts';

export const VERSION_DEFINITION: CommandDefinition = {
  name: 'version',
  summary: 'Print the installed Raphael release.',
  group: 'Setup',
  writes: false,
  usage: ['raphael version [--json]', 'raphael --version [--json]'],
  behavior: [
    'Works offline: reads no configuration and contacts no server.',
    'To compare with a server, run raphael status, which reports both sides.',
  ],
  options: [
    {
      name: 'json',
      type: 'boolean',
      description: 'Also print the protocol version, as one JSON document.',
    },
    { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' },
  ],
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
    'Commands take precedence over topics. Help works without a connection or saved login.',
    'help reference prints every page in one stream.',
  ],
  options: [
    { name: 'json', type: 'boolean', description: 'Print machine-readable command definitions.' },
    { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' },
  ],
  examples: [
    { argv: ['help', 'create'] },
    { argv: ['help', 'reference'] },
    { argv: ['help', '--json', 'search'] },
  ],
  prints: 'Help text, or machine-readable definitions with --json.',
  next: 'raphael help reference',
  fieldFlags: {},
};
