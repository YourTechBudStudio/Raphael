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

import { readFileSync } from 'node:fs';

import { CREATE_TARGETS } from './modules/nodes/input.ts';

/**
 * The version this command actually is, read from the manifest it shipped with.
 *
 * Module-relative, never from the working directory: `src/help.ts` and the compiled `dist/help.js`
 * both sit exactly one level below the package root, so the same URL resolves to the same manifest
 * whether this runs from a checkout or from an install. A hand-maintained literal beside a
 * `package.json` that carries its own version is two answers to one question, and the installed one
 * is the answer that matters.
 *
 * Read on demand rather than at module load, so `raphael --help` still touches nothing at all. There
 * is no fallback: a package whose own manifest cannot be read is broken, and saying "0.0.0" would
 * hide that behind a plausible number.
 */
export const version = (): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('package manifest has no version field.');
  }
  const { version: value } = manifest as { readonly version: unknown };
  if (typeof value !== 'string' || value === '') {
    throw new Error('package manifest version is not a string.');
  }
  return value;
};

export const ROOT_HELP = `raphael - an actionable second brain for agents

Usage: raphael <command> [options]

Commands:
  login             Connect this machine to a Raphael server.
  create            Create an area or a project.
  update            Change an area, a project, or a note.
  move              Move an area, a project, or a note somewhere else.
  archive           Hide an area, a project, or a note from lists and search.
  restore           Bring back something you archived.
  get               Read one area or project.
  path              Print the current full path of an area or project.
  list              List what is inside an area or project.
  search            Find areas, projects and notes by their text.
  server serve      Run a Raphael server on this machine.
  help              Show this help.

Run "raphael <command> --help" for details of one command.

Addressing:
  Paths are how people address things: /work/raphael/backend
  Identifiers are how they stay addressable: --id 42
  A path changes when something is renamed or moved. An identifier does not.

Types: ${CREATE_TARGETS.join(', ')}

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
