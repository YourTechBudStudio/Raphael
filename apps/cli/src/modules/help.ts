import type { CommandDefinition } from '../shared/command.ts';

export const VERSION_DEFINITION: CommandDefinition = {
  name: 'version',
  summary: 'Print the installed Raphael version.',
  group: 'Setup',
  writes: false,
  usage: ['raphael version'],
  behavior: ['The version comes from the release manifest.'],
  options: [{ name: 'help', short: 'h', type: 'boolean', description: 'Show help.' }],
  examples: [{ argv: ['version'] }, { argv: ['--version'] }, { argv: ['version', '--help'] }],
  prints: 'The bare version number.',
  next: 'raphael help connecting',
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
