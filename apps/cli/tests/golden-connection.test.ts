import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { API_KEY_MAX_LENGTH } from '@raphael/contracts/connection';

import { invocationOf, toExitCode } from '../src/main.ts';
import {
  ConfigError,
  configLocation,
  saveConfig,
  type ConfigReason,
} from '../src/modules/connection/config.ts';
import { connectFrom, type ConnectionReason } from '../src/modules/connection/remote.ts';
import { newSession } from '../src/shared/command.ts';
import { runCli, STUB_KEY, type Ran } from './support/cli.ts';
import {
  assertErrorDocument,
  assertJsonMirrorsText,
  caseName,
  goldenSurface,
} from './support/golden.ts';

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
const main = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
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

/**
 * `get /work` with this environment, resolved exactly as the entry point resolves it, and with
 * `--json` when asked.
 */
const getWith = (
  json: boolean,
  environment: Readonly<Record<string, string | undefined>>,
  platform = process.platform,
): Promise<Ran> =>
  runCli(['get', '/work', ...(json ? ['--json'] : [])], {
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
const rendered = (error: unknown, json: boolean): Ran => {
  let stdout = '';
  let stderr = '';
  const code = toExitCode(
    error,
    {
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    newSession(invocationOf(['login', ...(json ? ['--json'] : [])])),
  );
  return { code, stdout, stderr };
};

/**
 * A case produces one or more labelled runs, as text or with `--json`, or explains why the reason
 * cannot be produced.
 */
type Case =
  | { readonly runs: (json: boolean) => Promise<ReadonlyArray<readonly [string, Ran]>> }
  | { readonly unreachable: string };

const CONFIG_CASES: Record<ConfigReason, Case> = {
  unsupported_platform: {
    runs: async (json) => [['windows', await getWith(json, {}, 'win32')]],
  },
  no_home: {
    // A child process, because `os.homedir()` reads the process's own HOME, not the environment a
    // case hands the CLI. An empty HOME is reported as the home directory, and refused.
    runs: async (json) =>
      (
        [
          ['get', ['get', '/work'], undefined],
          ['login', ['login', 'http://127.0.0.1:2', '--api-key-stdin'], `${STUB_KEY}\n`],
          ['logout', ['logout'], undefined],
        ] as const
      ).map(([label, argv, input]) => {
        const child = spawnSync(process.execPath, [main, ...argv, ...(json ? ['--json'] : [])], {
          env: { PATH: process.env.PATH ?? '', HOME: '' },
          encoding: 'utf8',
          timeout: 15_000,
          ...(input === undefined ? {} : { input }),
        });
        return [label, { code: child.status, stdout: child.stdout, stderr: child.stderr }] as const;
      }),
  },
  relative_xdg_config_home: {
    runs: async (json) => [
      ['relative', await getWith(json, { XDG_CONFIG_HOME: 'relative/config' })],
    ],
  },
  relative_home: {
    runs: async (json) => [['relative', await getWith(json, { HOME: 'relhome' })]],
  },
  directory_unusable: {
    runs: async (json) => {
      const open = savedConfig(configFile('http://127.0.0.1:2'), { directory: 0o755 });
      // XDG_CONFIG_HOME itself cannot be searched, so the directory beneath cannot be inspected.
      const sealed = temporary();
      const xdg = join(sealed, 'xdg');
      mkdirSync(xdg, { mode: 0o700 });
      chmodSync(xdg, 0o000);
      const unreadable = normalize(await getWith(json, { XDG_CONFIG_HOME: xdg }), sealed);
      chmodSync(xdg, 0o700);
      // A file where a directory on the way should be.
      const blocked = temporary();
      writeFileSync(join(blocked, 'file'), '');
      const notDirectory = normalize(
        await getWith(json, { XDG_CONFIG_HOME: join(blocked, 'file') }),
        blocked,
      );
      return [
        ['group-readable', normalize(await getWith(json, open.environment), open.root)],
        ['unreadable-xdg', unreadable],
        ['file-in-path', notDirectory],
      ];
    },
  },
  directory_uncreatable: {
    runs: async (json) => {
      // A parent directory nobody may create entries in.
      const root = temporary();
      const parent = join(root, 'read-only');
      mkdirSync(parent, { mode: 0o500 });
      chmodSync(parent, 0o500);
      let error: unknown;
      try {
        saveConfig(configLocation({ XDG_CONFIG_HOME: parent }), {
          endpoint: 'http://127.0.0.1:2',
          apiKey: STUB_KEY,
        });
      } catch (caught) {
        error = caught;
      }
      chmodSync(parent, 0o700);
      assert.ok(error instanceof ConfigError && error.reason === 'directory_uncreatable');
      return [['read-only-parent', normalize(rendered(error, json), root)]];
    },
  },
  file_unusable: {
    runs: async (json) => {
      const open = savedConfig(configFile('http://127.0.0.1:2'), { file: 0o644 });
      // A dotfile manager's link, pointing at a private file.
      const linked = savedConfig(undefined);
      const target = join(linked.root, 'real-config.json');
      writeFileSync(target, configFile('http://127.0.0.1:2'), { mode: 0o600 });
      symlinkSync(target, join(linked.root, 'raphael', 'config.json'));
      return [
        ['group-readable', normalize(await getWith(json, open.environment), open.root)],
        ['symlink', normalize(await getWith(json, linked.environment), linked.root)],
      ];
    },
  },
  file_unreadable: {
    runs: async (json) => {
      // Owner-only, so it passes the protection check, and write-only, so reading it fails.
      const blocked = savedConfig(configFile('http://127.0.0.1:2'), { file: 0o200 });
      return [['write-only', normalize(await getWith(json, blocked.environment), blocked.root)]];
    },
  },
  file_too_large: {
    runs: async (json) => {
      const large = savedConfig(' '.repeat(64 * 1024 + 1));
      return [['oversized', normalize(await getWith(json, large.environment), large.root)]];
    },
  },
  file_malformed: {
    runs: async (json) => {
      const notJson = savedConfig('not json');
      const incomplete = savedConfig(JSON.stringify({ endpoint: 'http://127.0.0.1:2' }));
      return [
        ['not-json', normalize(await getWith(json, notJson.environment), notJson.root)],
        ['missing-key', normalize(await getWith(json, incomplete.environment), incomplete.root)],
      ];
    },
  },
  not_configured: {
    runs: async (json) => {
      const noDirectory = temporary();
      const noFile = savedConfig(undefined);
      const emptyPair = temporary();
      return [
        [
          'no-directory',
          normalize(await getWith(json, { XDG_CONFIG_HOME: noDirectory }), noDirectory),
        ],
        ['no-file', normalize(await getWith(json, noFile.environment), noFile.root)],
        // `RAPHAEL_ENDPOINT= RAPHAEL_API_KEY= raphael …` unsets both, so the saved login is used.
        [
          'both-variables-empty',
          normalize(
            await getWith(json, {
              XDG_CONFIG_HOME: emptyPair,
              RAPHAEL_ENDPOINT: '',
              RAPHAEL_API_KEY: '',
            }),
            emptyPair,
          ),
        ],
      ];
    },
  },
  write_failed: {
    runs: async (json) => {
      // Owner-only and not writable, so it passes the protection check and the write fails.
      const root = temporary();
      mkdirSync(join(root, 'raphael'), { mode: 0o500 });
      chmodSync(join(root, 'raphael'), 0o500);
      let error: unknown;
      try {
        saveConfig(configLocation({ XDG_CONFIG_HOME: root }), {
          endpoint: 'http://127.0.0.1:2',
          apiKey: STUB_KEY,
        });
      } catch (caught) {
        error = caught;
      }
      chmodSync(join(root, 'raphael'), 0o700);
      assert.ok(error instanceof ConfigError && error.reason === 'write_failed');
      return [['read-only-directory', normalize(rendered(error, json), root)]];
    },
  },
};

const CONNECTION_CASES: Record<ConnectionReason, Case> = {
  incomplete_environment: {
    runs: async (json) => [
      ['key-without-endpoint', await getWith(json, { RAPHAEL_API_KEY: STUB_KEY })],
      ['endpoint-without-key', await getWith(json, { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2' })],
      // An empty variable counts as unset, so this is a key without an endpoint.
      ['empty-endpoint', await getWith(json, { RAPHAEL_ENDPOINT: '', RAPHAEL_API_KEY: STUB_KEY })],
    ],
  },
  malformed: {
    runs: async (json) => {
      const saved = savedConfig(configFile('127.0.0.1:3105'));
      return [
        [
          '',
          await getWith(json, { RAPHAEL_ENDPOINT: 'not an address', RAPHAEL_API_KEY: STUB_KEY }),
        ],
        [
          'bare-ip-and-port',
          await getWith(json, { RAPHAEL_ENDPOINT: '127.0.0.1:3105', RAPHAEL_API_KEY: STUB_KEY }),
        ],
        ['saved-bare-ip-and-port', normalize(await getWith(json, saved.environment), saved.root)],
      ];
    },
  },
  unsupported_scheme: {
    runs: async (json) => [
      ['', await getWith(json, { RAPHAEL_ENDPOINT: 'ftp://127.0.0.1', RAPHAEL_API_KEY: STUB_KEY })],
      // `localhost:` parses as a scheme; the fix is the missing http://.
      [
        'bare-host-and-port',
        await getWith(json, { RAPHAEL_ENDPOINT: 'localhost:3105', RAPHAEL_API_KEY: STUB_KEY }),
      ],
    ],
  },
  credentials_in_url: {
    runs: async (json) => [
      [
        '',
        await getWith(json, {
          RAPHAEL_ENDPOINT: 'http://me:pw@127.0.0.1',
          RAPHAEL_API_KEY: STUB_KEY,
        }),
      ],
    ],
  },
  query_not_allowed: {
    runs: async (json) => [
      [
        '',
        await getWith(json, {
          RAPHAEL_ENDPOINT: 'http://127.0.0.1/?a=1',
          RAPHAEL_API_KEY: STUB_KEY,
        }),
      ],
    ],
  },
  fragment_not_allowed: {
    runs: async (json) => [
      [
        '',
        await getWith(json, { RAPHAEL_ENDPOINT: 'http://127.0.0.1/#a', RAPHAEL_API_KEY: STUB_KEY }),
      ],
    ],
  },
  api_key_missing: {
    runs: async (json) => {
      // An empty key in the environment is an incomplete pair; a saved one reaches the transport.
      const saved = savedConfig(configFile('http://127.0.0.1:2', ''));
      return [['saved-empty-key', normalize(await getWith(json, saved.environment), saved.root)]];
    },
  },
  api_key_unsendable: {
    runs: async (json) => {
      const saved = savedConfig(configFile('http://127.0.0.1:2', `${STUB_KEY} `));
      const savedLong = savedConfig(
        configFile('http://127.0.0.1:2', 'k'.repeat(API_KEY_MAX_LENGTH + 1)),
      );
      return [
        [
          'environment',
          await getWith(json, {
            RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
            RAPHAEL_API_KEY: 'ключ-key',
          }),
        ],
        ['saved', normalize(await getWith(json, saved.environment), saved.root)],
        [
          'environment-too-long',
          await getWith(json, {
            RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
            RAPHAEL_API_KEY: 'k'.repeat(API_KEY_MAX_LENGTH + 1),
          }),
        ],
        ['saved-too-long', normalize(await getWith(json, savedLong.environment), savedLong.root)],
      ];
    },
  },
  timeout_out_of_range: {
    runs: async (json) => {
      const pair = { RAPHAEL_ENDPOINT: 'http://127.0.0.1:2', RAPHAEL_API_KEY: STUB_KEY };
      return [
        ['zero', await getWith(json, { ...pair, RAPHAEL_TIMEOUT: '0' })],
        ['too-long', await getWith(json, { ...pair, RAPHAEL_TIMEOUT: '121' })],
        ['not-seconds', await getWith(json, { ...pair, RAPHAEL_TIMEOUT: '1.5' })],
      ];
    },
  },
};

const pin = (surface: string, cases: Record<string, Case>): void => {
  for (const [reason, how] of Object.entries(cases)) {
    if ('unreachable' in how) {
      it.skip(`${reason} cannot be produced: ${how.unreachable}`);
      continue;
    }
    // Every run is pinned as text. As JSON, the first run of each reason is pinned and the others
    // are checked against their text.
    it(`renders ${reason}`, async () => {
      const texts = new Map<string, Ran>();
      for (const [label, ran] of await how.runs(false)) {
        assert.equal(ran.stdout, '', 'a connection failure prints nothing on stdout');
        connection.expectRun(caseName(surface, reason, label), ran);
        texts.set(label, ran);
      }
      const [first, ...rest] = await how.runs(true);
      for (const [label, ran] of first === undefined ? [] : [first]) {
        assertErrorDocument(ran, { exit: ran.code ?? -1, code: reason });
        connection.expectRun(caseName(surface, reason, label, 'json'), ran);
      }
      for (const [label, ran] of rest) {
        const text = texts.get(label);
        assert.ok(text !== undefined, `no text run for ${label}`);
        assertJsonMirrorsText(ran, text, { exit: ran.code ?? -1, code: reason });
      }
    });
  }
};

describe('configuration reasons', () => pin('config', CONFIG_CASES));
describe('connection reasons', () => pin('connection', CONNECTION_CASES));
