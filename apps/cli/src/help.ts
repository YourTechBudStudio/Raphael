/**
 * Help text.
 *
 * Literal and plain throughout. The design system's voice allows occasional dry humour in empty
 * states and footers; it also says actions, status, and errors stay literal, and a command reference
 * is all three. Someone reading this is trying to get something done.
 *
 * Nothing here reads configuration, the environment, the network, or the backend, which is what makes
 * `raphael help` work on a machine that is not set up yet.
 */

import { NODE_TYPES } from '@raphael/contracts/nodes';

export const VERSION = '0.0.0';

export const ROOT_HELP = `raphael - an actionable second brain for agents

Usage: raphael <command> [options]

Commands:
  login             Connect this machine to a Raphael server.
  create            Create an area or a project.
  get               Read one area or project.
  path              Print the current full path of an area or project.
  list              List what is inside an area or project.
  server serve      Run a Raphael server on this machine.
  help              Show this help.

Run "raphael <command> --help" for details of one command.

Addressing:
  Paths are how people address things: /work/raphael/backend
  Identifiers are how they stay addressable: --id 42
  A path changes when something is renamed or moved. An identifier does not.

Types: ${NODE_TYPES.join(', ')}

Connecting:
  "raphael login" saves an address and key with owner-only permissions.
  For scripts, set RAPHAEL_ENDPOINT and RAPHAEL_API_KEY together. Both or neither.

Options:
  -h, --help        Show help.
  -v, --version     Show the version.

Exit codes:
  0  success
  1  the command was right and the work did not succeed
  2  the command was wrong; nothing was sent`;

export const SERVER_HELP = `Usage: raphael server <subcommand>

Subcommands:
  serve     Run a Raphael server on this machine.

Run "raphael server serve --help" for details.`;
