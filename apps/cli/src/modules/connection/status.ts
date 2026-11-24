/**
 * `raphael status`: which server this CLI would talk to, and whether it can.
 *
 * It resolves the connection exactly as every remote command does, asks the server once what it is,
 * and reports the endpoint, where it came from, both protocol versions and both releases. It is the
 * one cheap, read-only call an agent makes first: exit 0 means the next command can work, and any
 * other exit is the same failure, with the same code, that the next command would have met.
 */

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from '../../distribution.ts';
import { UsageError, parseArgs } from '../../shared/args.ts';
import {
  HELP_OPTION,
  JSON_OPTION,
  optionsFor,
  type CommandContext,
  type CommandDefinition,
} from '../../shared/command.ts';
import type { ExitCode } from '../../shared/exit.ts';
import { reportClientFailure } from '../../shared/failure.ts';
import { forTerminal } from '../../shared/output.ts';
import { verifyServer } from '../../shared/server-check.ts';
import { renderSuccess, type Warning } from '../../shared/success.ts';
import { CLIENT_API_KEY_VARIABLE, CLIENT_ENDPOINT_VARIABLE } from '../../shared/variables.ts';

export const STATUS_DEFINITION: CommandDefinition = {
  name: 'status',
  summary: 'Check the connection: which server, from where, and whether it accepts the key.',
  group: 'Setup',
  writes: false,
  verifiesServer: true,
  usage: ['raphael status [--json]'],
  behavior: [
    `Uses the connection every remote command uses: ${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE} when both are set, otherwise the saved login.`,
    'Asks the server once whether the key is accepted and which protocol and release it runs. Changes nothing.',
    'Exit 0 means remote commands can work. Otherwise the exit code and error are the ones the next read would meet: 5 for no connection, a rejected key, a protocol mismatch, or an address that is not a Raphael server or does not speak HTTP; 6 when the server could not be reached or did not answer in time; 1 when the server failed. A write that meets the same failure after it was sent exits 7, because it may have been applied.',
  ],
  options: [JSON_OPTION, HELP_OPTION],
  examples: [
    { argv: ['status'] },
    { argv: ['status', '--json'], description: 'The check an agent runs first.' },
  ],
  prints:
    'The server address, its source, whether the key was accepted, and the protocol and release of each side. JSON has connection {endpoint, source, configFile}, protocolVersion, serverVersion (null when the server does not say) and cliVersion.',
  next: 'raphael list /',
  seeAlso: ['connecting'],
  fieldFlags: {},
};

export const runStatus = async (
  argv: readonly string[],
  context: CommandContext,
): Promise<ExitCode> => {
  const parsed = parseArgs(argv, optionsFor(STATUS_DEFINITION), 'status');
  if (parsed.positionals.length > 0) {
    throw new UsageError('status takes no arguments.', 'status');
  }
  const { streams, session } = context;
  const transport = context.transport();
  const check = await verifyServer(session, transport, context.signal);
  if (!check.ok) return reportClientFailure(streams, session, check.failure);

  const connection = session.connection;
  const cliVersion = version();
  const serverVersion = check.server.raphaelVersion ?? null;
  const warnings: Warning[] =
    serverVersion !== null && serverVersion !== cliVersion
      ? [
          {
            code: 'version_skew',
            message:
              `The server runs Raphael ${forTerminal(serverVersion)} and this CLI is ${cliVersion}. ` +
              'They speak the same protocol, so commands work; update one side to match.',
          },
        ]
      : [];

  return renderSuccess(streams, session, {
    data: {
      connection,
      protocolVersion: PROTOCOL_VERSION,
      serverVersion,
      cliVersion,
    },
    lines: () => [
      `Server:   ${forTerminal(connection?.endpoint ?? transport.endpoint.base)}`,
      `Source:   ${
        connection?.source === 'environment'
          ? `${CLIENT_ENDPOINT_VARIABLE} and ${CLIENT_API_KEY_VARIABLE}`
          : `saved login (${forTerminal(connection?.configFile ?? '')})`
      }`,
      'Key:      accepted',
      `Protocol: ${PROTOCOL_VERSION} (both sides)`,
      `Releases: server ${serverVersion === null ? 'unknown' : forTerminal(serverVersion)}, this CLI ${cliVersion}`,
    ],
    warnings,
  });
};
