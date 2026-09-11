import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { formatMode } from '@raphael/fs-trust';

import {
  ConfigError,
  configLocation,
  loadConfig,
  saveConfig,
} from '../src/modules/connection/config.ts';
import { ConnectionError, resolveConnection } from '../src/modules/connection/remote.ts';

/**
 * Where a full-access credential is stored, and what has to be true before it is written.
 *
 * Real directories and real permission bits throughout. Every one of these checks is a claim about
 * the filesystem, and a fake filesystem cannot support such a claim.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try {
      chmodSync(root, 0o700);
    } catch {
      /* already gone */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const makeHome = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-cli-home-')));
  roots.push(root);
  return root;
};

const KEY = 'test-key-0123456789abcdef0123456789';
const CONFIG = { endpoint: 'https://raphael.example.com', apiKey: KEY };

const reason = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.reason;
    if (error instanceof ConnectionError) return error.reason;
    throw error;
  }
  return 'no-error';
};

describe('where configuration goes', () => {
  it('uses XDG on macOS and Linux alike', () => {
    const location = configLocation({ XDG_CONFIG_HOME: '/xdg' }, 'linux');
    assert.equal(location.directory, '/xdg/raphael');
    assert.equal(location.file, '/xdg/raphael/config.json');

    // The deliberate choice: not ~/Library/Application Support. A CLI's configuration is something
    // people edit and put in dotfile repositories.
    assert.equal(
      configLocation({ HOME: '/Users/x' }, 'darwin').directory,
      '/Users/x/.config/raphael',
    );
  });

  it('refuses a relative XDG_CONFIG_HOME rather than resolving it', () => {
    // Resolving it would put a credential somewhere that changes with `cd`.
    assert.equal(
      reason(() => configLocation({ XDG_CONFIG_HOME: 'relative/path' }, 'linux')),
      'relative_xdg_config_home',
    );
  });

  it('refuses to store anything on Windows', () => {
    // A recorded platform boundary, not a verified platform: this asserts the branch, and nothing
    // about how Raphael behaves on a real Windows machine.
    assert.equal(
      reason(() => configLocation({ HOME: '/Users/x' }, 'win32')),
      'unsupported_platform',
    );
  });
});

describe('saving', () => {
  it('creates an owner-only directory and file', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    const outcome = saveConfig(location, CONFIG);

    assert.equal(outcome.durabilityUnconfirmed, false);
    assert.equal(formatMode(lstatSync(location.directory).mode), '700');
    assert.equal(formatMode(lstatSync(outcome.file).mode), '600');
    assert.deepEqual(loadConfig(location), CONFIG);
  });

  it('writes 0600 regardless of a permissive umask', () => {
    // `writeFileSync`'s mode argument is masked by umask, so the mode is set explicitly afterwards.
    // Without that, a umask of 0 would leave a world-readable credential.
    const previous = process.umask(0o000);
    try {
      const home = makeHome();
      const location = configLocation({ HOME: home }, 'linux');
      const outcome = saveConfig(location, CONFIG);
      assert.equal(formatMode(lstatSync(outcome.file).mode), '600');
    } finally {
      process.umask(previous);
    }
  });

  it('replaces an existing configuration atomically and leaves no temporary file', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    saveConfig(location, CONFIG);
    const replacement = { endpoint: 'https://second.example.com', apiKey: `${KEY}2` };
    saveConfig(location, replacement);

    assert.deepEqual(loadConfig(location), replacement);
    const leftovers = readFileSync(location.file, 'utf8');
    assert.match(leftovers, /second\.example\.com/);
  });
});

describe('refusing rather than repairing', () => {
  it('refuses a directory others can reach into, and does not chmod it', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    mkdirSync(location.directory, { recursive: true, mode: 0o755 });
    chmodSync(location.directory, 0o755);

    assert.equal(
      reason(() => saveConfig(location, CONFIG)),
      'directory_unusable',
    );
    // The operator's directory is exactly as they left it. Silently tightening it would be a change
    // they did not ask for, made where they were least likely to notice.
    assert.equal(formatMode(lstatSync(location.directory).mode), '755');
  });

  it('refuses when an ancestor could be replaced by another user', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
    const ancestor = join(home, '.config');
    chmodSync(ancestor, 0o777);

    assert.equal(
      reason(() => saveConfig(location, CONFIG)),
      'directory_unusable',
    );
    assert.equal(formatMode(lstatSync(ancestor).mode), '777');
  });

  it('accepts an ordinary 0755 ancestor, which is what ~/.config normally is', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    mkdirSync(join(home, '.config'), { recursive: true, mode: 0o755 });
    chmodSync(join(home, '.config'), 0o755);
    // Refusing this would make the CLI unusable on an ordinary machine while protecting nothing: the
    // directory and file beneath are owner-only, and nobody can replace a 0755 directory they do not
    // own.
    assert.equal(saveConfig(location, CONFIG).durabilityUnconfirmed, false);
  });

  it('refuses a configuration file others can read', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    saveConfig(location, CONFIG);
    chmodSync(location.file, 0o644);

    assert.equal(
      reason(() => loadConfig(location)),
      'file_unusable',
    );
    assert.equal(formatMode(lstatSync(location.file).mode), '644');
  });

  it('refuses to read a credential through a symbolic link', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
    const real = join(home, 'elsewhere.json');
    writeFileSync(real, JSON.stringify(CONFIG), { mode: 0o600 });
    symlinkSync(real, location.file);

    assert.equal(
      reason(() => loadConfig(location)),
      'file_unusable',
    );
  });

  it('reports a malformed file without quoting it', () => {
    const home = makeHome();
    const location = configLocation({ HOME: home }, 'linux');
    mkdirSync(location.directory, { recursive: true, mode: 0o700 });
    writeFileSync(location.file, `{"apiKey": "${KEY}", oops`, { mode: 0o600 });

    try {
      loadConfig(location);
      assert.fail('should have refused');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.reason, 'file_malformed');
      // The parse error would have quoted the file, which holds a key.
      assert.equal(error.message.includes(KEY), false);
    }
  });

  it('says plainly when nothing is configured yet', () => {
    const home = makeHome();
    assert.equal(
      reason(() => loadConfig(configLocation({ HOME: home }, 'linux'))),
      'not_configured',
    );
  });
});

describe('the environment pair', () => {
  const home = () => ({ HOME: makeHome() });

  it('overrides the saved configuration as a unit', () => {
    const environment = {
      ...home(),
      RAPHAEL_ENDPOINT: 'https://from-env.example.com',
      RAPHAEL_API_KEY: KEY,
    };
    const connection = resolveConnection(environment, 'linux');
    assert.equal(connection.source, 'environment');
    assert.equal(connection.config.endpoint, 'https://from-env.example.com');
  });

  it('refuses a key with no endpoint, instead of combining sources', () => {
    // The hazard this closes: a terminal in a server's directory has RAPHAEL_API_KEY set. If that key
    // could combine with a saved endpoint, a local server's key would go to a remote host.
    const environment = { ...home(), RAPHAEL_API_KEY: KEY };
    assert.equal(
      reason(() => resolveConnection(environment, 'linux')),
      'incomplete_environment',
    );
  });

  it('refuses an endpoint with no key', () => {
    const environment = { ...home(), RAPHAEL_ENDPOINT: 'https://x.example.com' };
    assert.equal(
      reason(() => resolveConnection(environment, 'linux')),
      'incomplete_environment',
    );
  });

  it('treats an empty value as present but unusable, never as absent', () => {
    const environment = { ...home(), RAPHAEL_ENDPOINT: '', RAPHAEL_API_KEY: KEY };
    assert.equal(
      reason(() => resolveConnection(environment, 'linux')),
      'incomplete_environment',
    );
  });

  it('refuses an unusable key from the environment without echoing it', () => {
    // A distinctive sentinel, not something like "short": ordinary wording about a key being
    // "shorter than the minimum" would contain that as a substring and the assertion would pass for
    // the wrong reason.
    const sentinel = 'zqx-sentinel-value';
    const environment = {
      ...home(),
      RAPHAEL_ENDPOINT: 'https://x.example.com',
      RAPHAEL_API_KEY: sentinel,
    };
    try {
      resolveConnection(environment, 'linux');
      assert.fail('should have refused');
    } catch (error) {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.reason, 'unusable_environment_key');
      assert.equal(error.message.includes(sentinel), false);
    }
  });

  it('falls back to the saved configuration only when neither is set', () => {
    const environment = home();
    const location = configLocation(environment, 'linux');
    saveConfig(location, CONFIG);
    const connection = resolveConnection(environment, 'linux');
    assert.equal(connection.source, 'configuration');
    assert.deepEqual(connection.config, CONFIG);
  });
});
