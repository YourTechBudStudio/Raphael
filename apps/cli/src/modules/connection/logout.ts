/**
 * `raphael logout`: remove the saved login.
 *
 * The same directory checks a save makes run first, so nothing is removed through a path another
 * user could have arranged. Having nothing to remove is not a failure. When the environment pair is
 * set, removing the file changes nothing about which server commands use, and the result says so.
 */

import { UsageError, parseArgs } from '../../shared/args.ts';
import { optionsFor, type CommandDefinition, type Session } from '../../shared/command.ts';
import type { ExitCode } from '../../shared/exit.ts';
import { forTerminal, type Streams } from '../../shared/output.ts';
import { renderSuccess, type Warning } from '../../shared/success.ts';
import { CLIENT_API_KEY_VARIABLE, CLIENT_ENDPOINT_VARIABLE } from '../../shared/variables.ts';
import { configLocation, removeConfig } from './config.ts';
import { environmentPair, environmentPairNote } from './remote.ts';

export const LOGOUT_DEFINITION: CommandDefinition = {
  name: 'logout',
  summary: 'Remove the saved login from this machine.',
  group: 'Setup',
  writes: false,
  usage: ['raphael logout [--json]'],
  behavior: [
    'Deletes the saved login file after checking that its directory is yours and private. Nothing on the server changes.',
    'With no saved login, says so and exits 0.',
    `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} are not changed; when they are set, commands keep using them, and logout warns.`,
  ],
  options: [
    { name: 'json', type: 'boolean', description: 'Print the result as one JSON document.' },
    { name: 'help', short: 'h', type: 'boolean', description: 'Show help.' },
  ],
  examples: [{ argv: ['logout'] }, { argv: ['logout', '--json'] }],
  prints:
    'What was removed, or that there was nothing to remove. JSON has removed, endpoint (null when unknown) and configFile.',
  next: 'raphael login',
  seeAlso: ['connecting'],
  fieldFlags: {},
};

export interface LogoutDependencies {
  readonly streams: Streams;
  readonly session: Session;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

export const runLogout = (argv: readonly string[], dependencies: LogoutDependencies): ExitCode => {
  const parsed = parseArgs(argv, optionsFor(LOGOUT_DEFINITION), 'logout');
  if (parsed.positionals.length > 0) {
    throw new UsageError('logout takes no arguments.', 'logout');
  }
  const outcome = removeConfig(configLocation(dependencies.environment, dependencies.platform));

  const pair = environmentPair(dependencies.environment);
  const warnings: Warning[] =
    pair === 'none'
      ? []
      : [
          {
            code: 'environment_still_set',
            message:
              pair === 'both'
                ? `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} are still set in this environment and will keep being used.`
                : environmentPairNote(pair, ''),
          },
        ];

  return renderSuccess(dependencies.streams, dependencies.session, {
    data: {
      removed: outcome.removed,
      endpoint: outcome.endpoint ?? null,
      configFile: outcome.file,
    },
    lines: () => [
      !outcome.removed
        ? 'No saved login to remove.'
        : outcome.endpoint === undefined
          ? `Removed the saved login at ${outcome.file}.`
          : `Removed the saved login for ${forTerminal(outcome.endpoint)}.`,
    ],
    warnings,
  });
};
