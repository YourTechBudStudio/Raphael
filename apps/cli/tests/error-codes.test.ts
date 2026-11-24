import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ConfigurationReason } from '@raphael/backend';
import type { ClientFailure, EndpointRejection } from '@raphael/client';
import { API_ERROR_CODES } from '@raphael/contracts';

import type { ConfigReason } from '../src/modules/connection/config.ts';
import type { ConnectionReason } from '../src/modules/connection/remote.ts';
import {
  CLI_ERROR_CODES,
  type CliErrorCode,
  type ErrorCodeEntry,
} from '../src/shared/error-codes.ts';
import { WARNING_CODES } from '../src/shared/success.ts';
import { runCli } from './support/cli.ts';

/**
 * Every code the CLI can put in `error.code` is in its one table, and help lists each.
 *
 * `Failure.code` is typed from the table, so a literal or a reason that is not in it fails the
 * typecheck. These tables make the same promise visible per source: each is keyed by the union a
 * code comes from, so a new member without an entry here fails the typecheck too, and the test then
 * fails until the table has it.
 */

const here = dirname(fileURLToPath(import.meta.url));

const CONFIG_REASONS: Record<ConfigReason, true> = {
  unsupported_platform: true,
  no_home: true,
  relative_xdg_config_home: true,
  relative_home: true,
  directory_unusable: true,
  directory_uncreatable: true,
  file_unusable: true,
  file_unreadable: true,
  file_too_large: true,
  file_malformed: true,
  not_configured: true,
  write_failed: true,
};

const CONNECTION_REASONS: Record<ConnectionReason, true> = {
  incomplete_environment: true,
  api_key_unsendable: true,
  malformed: true,
  unsupported_scheme: true,
  credentials_in_url: true,
  query_not_allowed: true,
  fragment_not_allowed: true,
  api_key_missing: true,
  timeout_out_of_range: true,
};

/** Login refuses an address it was given with the address check's own reason. */
const LOGIN_ADDRESS_REASONS: Record<EndpointRejection['reason'], true> = {
  malformed: true,
  unsupported_scheme: true,
  credentials_in_url: true,
  query_not_allowed: true,
  fragment_not_allowed: true,
};

/** `server serve` reports a configuration failure under the backend's own reason. */
const SERVE_CONFIGURATION_REASONS: Record<ConfigurationReason, true> = {
  config_unreadable: true,
  config_too_large: true,
  config_malformed: true,
  config_unsafe: true,
  config_invalid: true,
  env_unreadable: true,
  env_too_large: true,
  api_key_missing: true,
  api_key_unsendable: true,
  option_invalid: true,
};

/** The code each client failure kind is worded under, whatever its cause. */
const CLIENT_FAILURE_CODES: Record<ClientFailure['kind'], readonly CliErrorCode[]> = {
  invalid_request: ['invalid_request'],
  cancelled: ['interrupted'],
  network: ['not_http', 'unreachable', 'blocked_port', 'connection_lost'],
  timeout: ['timeout'],
  bad_response: ['bad_response', 'incompatible_protocol', 'not_raphael'],
  http: ['http_status', 'incompatible_protocol', 'not_raphael'],
};

const sourcesBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesBelow(join(directory, entry.name))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [join(directory, entry.name)]
        : [],
  );

/**
 * `server serve` prints only text, which carries no code, so its goldens are named here by the code
 * the test that writes each one checks it under.
 */
const SERVE_GOLDENS: Partial<Record<CliErrorCode, readonly string[]>> = {
  port_in_use: ['serve/port-in-use.golden'],
  listen_denied: ['serve/listen-denied.golden'],
  host_unavailable: ['serve/host-unavailable.golden'],
  listen_failed: ['serve/listen-unexplained.golden'],
  database_in_use: ['serve/database-in-use.golden'],
  database_newer: ['serve/database-newer.golden'],
  database_unusable: [
    'serve/database-foreign.golden',
    'serve/database-partly-migrated.golden',
    'serve/database-unexplained.golden',
  ],
  start_failed: ['serve/start-failed.golden'],
  option_invalid: ['serve/option-invalid-host.golden', 'serve/option-invalid-config.golden'],
  config_unreadable: ['serve/config-unreadable.golden'],
  config_too_large: ['serve/config-too-large.golden'],
  config_malformed: ['serve/config-malformed.golden', 'serve/config-malformed-empty.golden'],
  config_unsafe: ['serve/config-unsafe.golden'],
  config_invalid: ['serve/config-invalid.golden'],
  env_unreadable: ['serve/env-unreadable-directory.golden'],
  env_too_large: ['serve/env-too-large.golden'],
};

/** Codes no run can produce, and why. Nothing else may go without a golden. */
const UNREACHABLE: Partial<Record<CliErrorCode, string>> = {
  invalid_request:
    'every field the request decoder checks is checked first by the contracts inspectors the CLI runs',
};

const goldenRoot = join(here, 'golden');

const goldensBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? goldensBelow(join(directory, entry.name))
      : entry.name.endsWith('.golden')
        ? [join(directory, entry.name)]
        : [],
  );

const exitOf = (golden: string): number => Number(/^==== exit ====\n(\d+)\n/u.exec(golden)?.[1]);

describe('error codes', () => {
  const table = new Set<string>(Object.keys(CLI_ERROR_CODES));

  it('lists every reason a failure is reported under', () => {
    const reasons = [
      ...Object.keys(CONFIG_REASONS),
      ...Object.keys(CONNECTION_REASONS),
      ...Object.keys(LOGIN_ADDRESS_REASONS),
      ...Object.keys(SERVE_CONFIGURATION_REASONS),
      ...Object.values(CLIENT_FAILURE_CODES).flat(),
    ];
    assert.deepEqual(
      reasons.filter((reason) => !table.has(reason)),
      [],
    );
  });

  it('lists every code literal the sources give a failure', () => {
    const known = new Set<string>([...table, ...API_ERROR_CODES, ...Object.keys(WARNING_CODES)]);
    const missing: string[] = [];
    for (const file of sourcesBelow(join(here, '../src'))) {
      const source = readFileSync(file, 'utf8');
      for (const [, code] of source.matchAll(/\bcode:\s*'([a-z_]+)'/gu)) {
        if (code !== undefined && !known.has(code)) missing.push(`${file}: ${code}`);
      }
      // A local helper's first argument is the code, as in serve's startup failures.
      for (const [, code] of source.matchAll(
        /\b(?:failure|notListening|refused)\(\s*(?:dependencies,\s*)?'([a-z_]+)'/gu,
      )) {
        if (code !== undefined && !known.has(code)) missing.push(`${file}: ${code}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('pins every CLI code in a golden, with an exit code the table lists', () => {
    const pinned = new Set<string>();
    const wrongExit: string[] = [];
    for (const file of goldensBelow(goldenRoot)) {
      // Help lists every code; a failure golden is what shows one being given.
      if (file.startsWith(join(goldenRoot, 'help'))) continue;
      const golden = readFileSync(file, 'utf8');
      for (const [line] of golden.matchAll(/^\{"ok":false.*$/gmu)) {
        const { error } = JSON.parse(line) as { error: { code: string; exitCode: number } };
        pinned.add(error.code);
        const entry = (CLI_ERROR_CODES as Record<string, ErrorCodeEntry | undefined>)[error.code];
        if (entry !== undefined && !(entry.exits as readonly number[]).includes(error.exitCode)) {
          wrongExit.push(`${file}: ${error.code} exits ${error.exitCode}`);
        }
      }
    }
    for (const [code, files] of Object.entries(SERVE_GOLDENS)) {
      assert.equal(CLI_ERROR_CODES[code as CliErrorCode].source, 'server serve', code);
      for (const file of files) {
        const path = join(goldenRoot, file);
        assert.ok(existsSync(path), `${code}: no golden at ${file}`);
        pinned.add(code);
        const exit = exitOf(readFileSync(path, 'utf8'));
        if (!(CLI_ERROR_CODES[code as CliErrorCode].exits as readonly number[]).includes(exit)) {
          wrongExit.push(`${file}: ${code} exits ${exit}`);
        }
      }
    }
    assert.deepEqual(wrongExit, []);
    assert.deepEqual(
      Object.keys(CLI_ERROR_CODES).filter((code) => !pinned.has(code) && !(code in UNREACHABLE)),
      [],
      'a CLI code with no golden',
    );
    assert.deepEqual(
      Object.keys(UNREACHABLE).filter((code) => pinned.has(code)),
      [],
      'a code recorded as unreachable has a golden',
    );
  });

  it('keeps server codes and warning codes out of the CLI table', () => {
    assert.deepEqual(
      [...API_ERROR_CODES, ...Object.keys(WARNING_CODES)].filter((code) => table.has(code)),
      [],
    );
  });

  it('renders every code in the exit-codes and output topics and in help --json', async () => {
    const topic = (await runCli(['help', 'exit-codes'])).stdout;
    const output = (await runCli(['help', 'output'])).stdout.replaceAll(/\s+/gu, ' ');
    const json = JSON.parse((await runCli(['help', '--json'])).stdout) as {
      errorCodes: readonly { code: string; exitCodes: readonly number[]; meaning?: string }[];
    };
    for (const [code, entry] of Object.entries(CLI_ERROR_CODES)) {
      assert.match(topic, new RegExp(`^ {2}${code} +Exit `, 'mu'), code);
      assert.ok(output.includes(` ${code},`) || output.includes(` ${code};`), code);
      const listed = json.errorCodes.find((candidate) => candidate.code === code);
      assert.deepEqual(listed?.exitCodes, entry.exits, code);
      assert.equal(listed?.meaning, entry.meaning, code);
    }
    for (const code of API_ERROR_CODES) {
      assert.match(topic, new RegExp(`^ {2}${code} +Exit `, 'mu'), code);
      assert.ok(
        json.errorCodes.some((candidate) => candidate.code === code),
        code,
      );
    }
  });
});
