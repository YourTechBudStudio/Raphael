import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { toExitCode } from '../src/main.ts';
import {
  ConfigError,
  configLocation,
  saveConfig,
  type ConfigReason,
} from '../src/modules/connection/config.ts';
import { connectFrom, type ConnectionReason } from '../src/modules/connection/remote.ts';
import { runCli, STUB_KEY, type Ran } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * How every reason a connection cannot be set up reads, through the whole CLI.
 *
 * Each case builds the real condition - a temporary configuration directory with the wrong mode, an
 * environment pair with one half missing - and runs `get /work` with the entry point's own resolver.
 * Temporary paths, the uid, and the process id are replaced with placeholders so the files do not depend on the
 * machine.
 *
 * The tables are keyed by the reason unions, so a new reason without a case fails the typecheck.
 */

const connection = goldenSurface('connection');
const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    // A case may leave a directory without write or search permission.
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(connection.strays(), []);
});

const temporary = (): string => {
  // Resolved, because /tmp is a symlink on macOS and the configuration checks verify a resolved chain.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-connection-')));
  directories.push(directory);
  return directory;
};

const normalize = (ran: Ran, root: string): Ran => {
  const scrub = (text: string): string =>
    text
      .replaceAll(root, '<tmp>')
      .replaceAll(`uid ${process.getuid?.() ?? ''}`, 'uid <uid>')
      // The temporary file a save writes first is named after the process.
      .replaceAll(`.${process.pid}.tmp`, '.<pid>.tmp');
  return { code: ran.code, stdout: scrub(ran.stdout), stderr: scrub(ran.stderr) };
};

/** `get /work` with this environment, resolved exactly as the entry point resolves it. */
const getWith = (
  environment: Readonly<Record<string, string | undefined>>,
  platform = process.platform,
): Promise<Ran> =>
  runCli(['get', '/work'], {
    environment,
    platform,
    connect: () => connectFrom(environment, platform),
  });

/** A saved configuration directory under a fresh XDG_CONFIG_HOME, with its file written as given. */
const savedConfig = (
  file: string | undefined,
  modes: { readonly directory?: number; readonly file?: number } = {},
): { readonly root: string; readonly environment: Record<string, string> } => {
  const root = temporary();
  const directory = join(root, 'raphael');
  mkdirSync(directory, { mode: 0o700 });
  if (file !== undefined) {
    const path = join(directory, 'config.json');
    writeFileSync(path, file, { mode: 0o600 });
    chmodSync(path, modes.file ?? 0o600);
  }
  chmodSync(directory, modes.directory ?? 0o700);
  return { root, environment: { XDG_CONFIG_HOME: root } };
};

const configFile = (endpoint: string, apiKey = STUB_KEY): string =>
  JSON.stringify({ endpoint, apiKey });

/**
 * Render a configuration error the way the CLI does, for the reasons only `login` can reach once a
 * server has verified the connection. `login` lets these propagate unchanged to `toExitCode`.
 */
const rendered = (error: unknown): Ran => {
  let stdout = '';
  let stderr = '';
  const code = toExitCode(error, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
};

/** A case produces one or more labelled runs, or explains why the reason cannot be produced. */
type Case =
  | { readonly runs: () => Promise<ReadonlyArray<readonly [string, Ran]>> }
  | { readonly unreachable: string };

const CONFIG_CASES: Record<ConfigReason, Case> = {
  unsupported_platform: {
    runs: async () => [['windows', await getWith({}, 'win32')]],
  },
  no_home: {
    unreachable:
      'needs an empty HOME and an empty home directory from the user database; os.homedir() always ' +
      'finds one for a real user',
  },
  relative_xdg_config_home: {
    runs: async () => [['relative', await getWith({ XDG_CONFIG_HOME: 'relative/config' })]],
  },
  directory_unusable: {
    runs: async () => {
      const open = savedConfig(configFile('http://127.0.0.1:9'), { directory: 0o755 });
      return [['group-readable', normalize(await getWith(open.environment), open.root)]];
    },
  },
  directory_uncreatable: {
    runs: async () => {
      // A parent directory nobody may create entries in.
      const root = temporary();
      const parent = join(root, 'read-only');
      mkdirSync(parent, { mode: 0o500 });
      chmodSync(parent, 0o500);
      let error: unknown;
      try {
        saveConfig(configLocation({ XDG_CONFIG_HOME: parent }), {
          endpoint: 'http://127.0.0.1:9',
          apiKey: STUB_KEY,
        });
      } catch (caught) {
        error = caught;
      }
      chmodSync(parent, 0o700);
      assert.ok(error instanceof ConfigError && error.reason === 'directory_uncreatable');
      return [['read-only-parent', normalize(rendered(error), root)]];
    },
  },
  file_unusable: {
    runs: async () => {
      const open = savedConfig(configFile('http://127.0.0.1:9'), { file: 0o644 });
      return [['group-readable', normalize(await getWith(open.environment), open.root)]];
    },
  },
  file_unreadable: {
    runs: async () => {
      // Owner-only, so it passes the protection check, and write-only, so reading it fails.
      const blocked = savedConfig(configFile('http://127.0.0.1:9'), { file: 0o200 });
      return [['write-only', normalize(await getWith(blocked.environment), blocked.root)]];
    },
  },
  file_too_large: {
    runs: async () => {
      const large = savedConfig(' '.repeat(64 * 1024 + 1));
      return [['oversized', normalize(await getWith(large.environment), large.root)]];
    },
  },
  file_malformed: {
    runs: async () => {
      const notJson = savedConfig('not json');
      const incomplete = savedConfig(JSON.stringify({ endpoint: 'http://127.0.0.1:9' }));
      return [
        ['not-json', normalize(await getWith(notJson.environment), notJson.root)],
        ['missing-key', normalize(await getWith(incomplete.environment), incomplete.root)],
      ];
    },
  },
  not_configured: {
    runs: async () => {
      const noDirectory = temporary();
      const noFile = savedConfig(undefined);
      return [
        ['no-directory', normalize(await getWith({ XDG_CONFIG_HOME: noDirectory }), noDirectory)],
        ['no-file', normalize(await getWith(noFile.environment), noFile.root)],
      ];
    },
  },
  write_failed: {
    runs: async () => {
      // Owner-only and not writable, so it passes the protection check and the write fails.
      const root = temporary();
      mkdirSync(join(root, 'raphael'), { mode: 0o500 });
      chmodSync(join(root, 'raphael'), 0o500);
      let error: unknown;
      try {
        saveConfig(configLocation({ XDG_CONFIG_HOME: root }), {
          endpoint: 'http://127.0.0.1:9',
          apiKey: STUB_KEY,
        });
      } catch (caught) {
        error = caught;
      }
      chmodSync(join(root, 'raphael'), 0o700);
      assert.ok(error instanceof ConfigError && error.reason === 'write_failed');
      return [['read-only-directory', normalize(rendered(error), root)]];
    },
  },
  durability_unconfirmed: {
    unreachable:
      'never thrown: saveConfig reports it as an outcome flag, and only when flushing the directory ' +
      'fails after the rename, which a test cannot cause',
  },
};

const CONNECTION_CASES: Record<ConnectionReason, Case> = {
  incomplete_environment: {
    runs: async () => [
      ['key-without-endpoint', await getWith({ RAPHAEL_API_KEY: STUB_KEY })],
      ['endpoint-without-key', await getWith({ RAPHAEL_ENDPOINT: 'http://127.0.0.1:9' })],
    ],
  },
  malformed: {
    runs: async () => [
      ['', await getWith({ RAPHAEL_ENDPOINT: 'not an address', RAPHAEL_API_KEY: STUB_KEY })],
    ],
  },
  unsupported_scheme: {
    runs: async () => [
      ['', await getWith({ RAPHAEL_ENDPOINT: 'ftp://127.0.0.1', RAPHAEL_API_KEY: STUB_KEY })],
    ],
  },
  credentials_in_url: {
    runs: async () => [
      [
        '',
        await getWith({ RAPHAEL_ENDPOINT: 'http://me:pw@127.0.0.1', RAPHAEL_API_KEY: STUB_KEY }),
      ],
    ],
  },
  query_not_allowed: {
    runs: async () => [
      ['', await getWith({ RAPHAEL_ENDPOINT: 'http://127.0.0.1/?a=1', RAPHAEL_API_KEY: STUB_KEY })],
    ],
  },
  fragment_not_allowed: {
    runs: async () => [
      ['', await getWith({ RAPHAEL_ENDPOINT: 'http://127.0.0.1/#a', RAPHAEL_API_KEY: STUB_KEY })],
    ],
  },
  api_key_missing: {
    runs: async () => {
      // An empty key in the environment is an incomplete pair; a saved one reaches the transport.
      const saved = savedConfig(configFile('http://127.0.0.1:9', ''));
      return [['saved-empty-key', normalize(await getWith(saved.environment), saved.root)]];
    },
  },
  timeout_out_of_range: {
    unreachable: 'the CLI never passes a timeout to the transport; phase 04 adds RAPHAEL_TIMEOUT',
  },
};

const pin = (surface: string, cases: Record<string, Case>): void => {
  for (const [reason, how] of Object.entries(cases)) {
    if ('unreachable' in how) {
      it.skip(`${reason} cannot be produced: ${how.unreachable}`);
      continue;
    }
    it(`renders ${reason}`, async () => {
      for (const [label, ran] of await how.runs()) {
        assert.equal(ran.stdout, '', 'a connection failure prints nothing on stdout');
        connection.expectRun(caseName(surface, reason, label), ran);
      }
    });
  }
};

describe('configuration reasons', () => pin('config', CONFIG_CASES));
describe('connection reasons', () => pin('connection', CONNECTION_CASES));
