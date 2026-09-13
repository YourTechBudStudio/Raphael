import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { Effect } from 'effect';

import { ApiCredential } from '../src/infrastructure/config/credential.ts';
import { API_KEY_VARIABLE, loadEnvironment } from '../src/infrastructure/config/env.ts';
import { ConfigurationError } from '../src/infrastructure/config/errors.ts';
import { loadConfiguration } from '../src/infrastructure/config/index.ts';
import {
  CONFIG_DEFAULTS,
  validateOptions,
  type BackendOptions,
} from '../src/infrastructure/config/options.ts';
import { openDatabase } from '../src/infrastructure/database/connection.ts';
import { silentLogger } from '../src/infrastructure/http/log.ts';
import { serve } from '../src/server.ts';
import { tempDatabase } from './support.ts';

/**
 * Configuration: what is accepted, what is refused, and where a value came from.
 *
 * A usable key is needed for almost every case, so these build one per test rather than sharing a
 * fixture. None of them is a real credential and none reaches a committed file.
 */

const GOOD_KEY = `test-${'k'.repeat(40)}`;

const withTempDir = <T>(tag: string, body: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), `raphael-${tag}-`));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const writeConfig = (dir: string, yaml: string): string => {
  const path = join(dir, 'raphael.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
};

/** Load with an isolated environment, so a developer's own `RAPHAEL_API_KEY` cannot affect a test. */
const load = (context: {
  dir: string;
  configPath?: string;
  env?: Record<string, string>;
  readEnvFile?: boolean;
}) =>
  loadConfiguration({
    cwd: context.dir,
    processEnv: context.env ?? { [API_KEY_VARIABLE]: GOOD_KEY },
    ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
    ...(context.readEnvFile === undefined ? {} : { readEnvFile: context.readEnvFile }),
  });

const refuses = (run: () => unknown, reason: string): ConfigurationError => {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof ConfigurationError,
      `expected a ConfigurationError, got ${String(error)}`,
    );
    assert.equal(error.reason, reason);
    return error;
  }
  throw new Error(`expected a ${reason} failure, but the configuration loaded`);
};

describe('defaults and resolution', () => {
  test('no file at all produces the documented defaults', () => {
    withTempDir('config-defaults', (dir) => {
      const { options } = load({ dir, readEnvFile: false });
      assert.equal(options.server.host, CONFIG_DEFAULTS.host);
      assert.equal(options.server.port, CONFIG_DEFAULTS.port);
      assert.equal(options.database.busyTimeoutMs, CONFIG_DEFAULTS.busyTimeoutMs);
      assert.equal(options.idempotency.gcIntervalMinutes, CONFIG_DEFAULTS.gcIntervalMinutes);
      assert.equal(options.idempotency.gcBatchSize, CONFIG_DEFAULTS.gcBatchSize);
      // With no file, a relative default resolves against the invocation directory.
      assert.equal(options.database.databasePath, resolve(dir, CONFIG_DEFAULTS.databasePath));
    });
  });

  test('a relative database path resolves against the configuration file, not the invocation directory', () => {
    withTempDir('config-relative', (dir) => {
      const nested = join(dir, 'etc');
      writeFileSync(join(dir, 'marker'), '', 'utf8');
      rmSync(nested, { recursive: true, force: true });
      writeFileSync(join(dir, 'raphael.yaml'), 'database:\n  path: ./var/raphael.sqlite\n', 'utf8');

      const { options } = load({
        dir: join(dir, 'somewhere-else'),
        configPath: join(dir, 'raphael.yaml'),
        readEnvFile: false,
      });
      assert.equal(options.database.databasePath, resolve(dir, 'var/raphael.sqlite'));
    });
  });

  test('an absolute database path is taken as given', () => {
    withTempDir('config-absolute', (dir) => {
      const path = writeConfig(dir, `database:\n  path: ${join(dir, 'data.sqlite')}\n`);
      const { options } = load({ dir, configPath: path, readEnvFile: false });
      assert.equal(options.database.databasePath, join(dir, 'data.sqlite'));
    });
  });

  test('stated values win over defaults', () => {
    withTempDir('config-values', (dir) => {
      const path = writeConfig(
        dir,
        'server:\n  host: 0.0.0.0\n  port: 8080\ndatabase:\n  busyTimeoutMs: 250\nidempotency:\n  gcIntervalMinutes: 5\n  gcBatchSize: 10\n',
      );
      const { options } = load({ dir, configPath: path, readEnvFile: false });
      assert.equal(options.server.host, '0.0.0.0');
      assert.equal(options.server.port, 8080);
      assert.equal(options.database.busyTimeoutMs, 250);
      assert.equal(options.idempotency.gcIntervalMinutes, 5);
      assert.equal(options.idempotency.gcBatchSize, 10);
    });
  });
});

describe('a configuration file is read as data', () => {
  test('an unknown field is refused rather than ignored', () => {
    withTempDir('config-unknown', (dir) => {
      const path = writeConfig(dir, 'server:\n  prot: 3000\n');
      const error = refuses(
        () => load({ dir, configPath: path, readEnvFile: false }),
        'config_invalid',
      );
      assert.match(error.message, /prot/u);
    });
  });

  test('a duplicate key is an error, not a silent last-one-wins', () => {
    withTempDir('config-duplicate', (dir) => {
      const path = writeConfig(dir, 'server:\n  port: 3000\nserver:\n  port: 4000\n');
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
    });
  });

  test('a duplicate key nested inside one mapping is caught too', () => {
    withTempDir('config-duplicate-nested', (dir) => {
      const path = writeConfig(dir, 'server:\n  port: 3000\n  port: 4000\n');
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
    });
  });

  test('anchors, aliases, and merge keys are all refused', () => {
    withTempDir('config-anchors', (dir) => {
      for (const source of [
        'defaults: &d\n  port: 3000\nserver: *d\n',
        'anchored: &d 3000\nserver:\n  port: 1234\n',
        'defaults: &d\n  port: 3000\nserver:\n  <<: *d\n',
      ]) {
        const path = writeConfig(dir, source);
        refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_unsafe');
      }
    });
  });

  test('an explicit tag is refused, standard or custom', () => {
    withTempDir('config-tags', (dir) => {
      for (const source of [
        'server:\n  host: !!binary aGk=\n',
        'server:\n  host: !Custom {}\n',
        'server:\n  port: !!str 3000\n',
      ]) {
        const path = writeConfig(dir, source);
        const error = refuses(
          () => load({ dir, configPath: path, readEnvFile: false }),
          'config_unsafe',
        );
        assert.match(error.message, /tag/u);
      }
    });
  });

  test('more than one document in a file is refused', () => {
    withTempDir('config-multidoc', (dir) => {
      const path = writeConfig(dir, 'server:\n  port: 3000\n---\nserver:\n  port: 4000\n');
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_unsafe');
    });
  });

  test('an explicitly supplied path that cannot be read fails rather than falling back', () => {
    withTempDir('config-missing', (dir) => {
      refuses(
        () => load({ dir, configPath: join(dir, 'absent.yaml'), readEnvFile: false }),
        'config_unreadable',
      );
    });
  });

  test('a file larger than the limit is refused before it is parsed', () => {
    withTempDir('config-large', (dir) => {
      const path = writeConfig(dir, `# ${'x'.repeat(100_000)}\nserver:\n  port: 3000\n`);
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_too_large');
    });
  });

  test('YAML 1.1 spellings do not survive the core schema', () => {
    withTempDir('config-core-schema', (dir) => {
      // `yes` is a string under the 1.2 core schema, so this fails as a wrong type rather than
      // silently becoming a boolean host.
      const path = writeConfig(dir, 'server:\n  port: yes\n');
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
    });
  });
});

describe('bounds', () => {
  test('port 0 is refused in a file, because an arbitrary port is useless to a client', () => {
    withTempDir('config-port-zero', (dir) => {
      const path = writeConfig(dir, 'server:\n  port: 0\n');
      refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
    });
  });

  test('every numeric option is bounded at both ends', () => {
    withTempDir('config-bounds', (dir) => {
      const outOfRange = [
        'server:\n  port: 65536\n',
        'server:\n  port: -1\n',
        'server:\n  port: 3000.5\n',
        'database:\n  busyTimeoutMs: -1\n',
        'database:\n  busyTimeoutMs: 600000\n',
        'idempotency:\n  gcIntervalMinutes: 0\n',
        'idempotency:\n  gcBatchSize: 0\n',
        // A negative LIMIT means *no limit* to SQLite, so a negative batch size must never get past
        // validation into the delete statement.
        'idempotency:\n  gcBatchSize: -1\n',
        'idempotency:\n  gcBatchSize: 100000\n',
      ];
      for (const source of outOfRange) {
        const path = writeConfig(dir, source);
        refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
      }
    });
  });

  test('a host with whitespace or a control character is refused', () => {
    withTempDir('config-host', (dir) => {
      for (const host of ['"127.0.0.1 "', '"1 2 7"', '"127.0.0.1\\u0000"']) {
        const path = writeConfig(dir, `server:\n  host: ${host}\n`);
        refuses(() => load({ dir, configPath: path, readEnvFile: false }), 'config_invalid');
      }
    });
  });
});

describe('the environment and the credential', () => {
  test('the process environment wins over a .env file', () => {
    withTempDir('env-precedence', (dir) => {
      writeFileSync(join(dir, '.env'), `${API_KEY_VARIABLE}=${'f'.repeat(40)}\n`, 'utf8');
      const environment = loadEnvironment({
        cwd: dir,
        processEnv: { [API_KEY_VARIABLE]: GOOD_KEY },
      });
      assert.equal(environment.get(API_KEY_VARIABLE), GOOD_KEY);
      assert.equal(environment.sourceOf(API_KEY_VARIABLE), 'process');
    });
  });

  test('an explicitly empty process variable still wins, and then fails validation', () => {
    withTempDir('env-empty', (dir) => {
      writeFileSync(join(dir, '.env'), `${API_KEY_VARIABLE}=${GOOD_KEY}\n`, 'utf8');
      const environment = loadEnvironment({ cwd: dir, processEnv: { [API_KEY_VARIABLE]: '' } });
      // Setting a variable to the empty string is a statement. It is not the same as not setting it,
      // and it must not silently fall through to a file value the operator may have forgotten.
      assert.equal(environment.get(API_KEY_VARIABLE), '');
      assert.equal(environment.sourceOf(API_KEY_VARIABLE), 'process');

      refuses(() => load({ dir, env: { [API_KEY_VARIABLE]: '' } }), 'api_key_missing');
    });
  });

  test('a .env supplies what the process environment does not define', () => {
    withTempDir('env-file', (dir) => {
      writeFileSync(join(dir, '.env'), `${API_KEY_VARIABLE}=${GOOD_KEY}\n`, 'utf8');
      const environment = loadEnvironment({ cwd: dir, processEnv: {} });
      assert.equal(environment.get(API_KEY_VARIABLE), GOOD_KEY);
      assert.equal(environment.sourceOf(API_KEY_VARIABLE), 'file');
    });
  });

  test('loading never mutates the real process environment', () => {
    withTempDir('env-no-mutation', (dir) => {
      writeFileSync(join(dir, '.env'), 'RAPHAEL_TEST_MARKER=set-by-file\n', 'utf8');
      loadEnvironment({ cwd: dir, processEnv: { [API_KEY_VARIABLE]: GOOD_KEY } });
      assert.equal(process.env.RAPHAEL_TEST_MARKER, undefined);
    });
  });

  test('an absent .env is ordinary, an unreadable one is not', () => {
    withTempDir('env-unreadable', (dir) => {
      assert.doesNotThrow(() => loadEnvironment({ cwd: dir, processEnv: {} }));

      const path = join(dir, '.env');
      writeFileSync(path, `${API_KEY_VARIABLE}=${GOOD_KEY}\n`, 'utf8');
      chmodSync(path, 0o000);
      try {
        refuses(() => load({ dir, env: {} }), 'env_unreadable');
      } finally {
        chmodSync(path, 0o600);
      }
    });
  });

  test('a .env property named __proto__ is read as data, not as a prototype', () => {
    withTempDir('env-proto', (dir) => {
      writeFileSync(
        join(dir, '.env'),
        `__proto__=polluted\n${API_KEY_VARIABLE}=${GOOD_KEY}\n`,
        'utf8',
      );
      const environment = loadEnvironment({ cwd: dir, processEnv: {} });
      assert.equal(environment.get(API_KEY_VARIABLE), GOOD_KEY);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });
  });

  test('a missing key fails before anything is acquired', () => {
    withTempDir('key-missing', (dir) => {
      const error = refuses(() => load({ dir, env: {}, readEnvFile: false }), 'api_key_missing');
      assert.match(error.message, /RAPHAEL_API_KEY/u);
    });
  });

  test('a key is whatever the owner configured, of any length or alphabet', () => {
    withTempDir('key-shapes', (dir) => {
      // There is no length floor and no character set. Hex, base64, a passphrase with spaces, a
      // single character: if it started the server, it is the key.
      for (const key of [
        'x',
        'a3f9'.repeat(16),
        'Zm9vYmFyLWJhei1xdXV4LWNvcmdlLWdyYXVsdA==',
        'a key with spaces',
        `${GOOD_KEY}\n`,
        '\u{1F511}'.repeat(8),
      ]) {
        assert.doesNotThrow(
          () => load({ dir, env: { [API_KEY_VARIABLE]: key }, readEnvFile: false }),
          JSON.stringify(key),
        );
      }
    });
  });

  test('a key is stored exactly as given, never trimmed', () => {
    // Quietly trimming would make a server that accepts a key its owner did not set, and reject the
    // one they did. Whatever surrounding whitespace they configured is part of the credential.
    const padded = `  ${GOOD_KEY}  `;
    const credential = ApiCredential.fromKey(padded);
    assert.equal(credential.matches(padded), true);
    assert.equal(credential.matches(GOOD_KEY), false);
  });

  test('a key that cannot travel in a header still starts the server', () => {
    // Deliberate, and worth stating. An HTTP header carries bytes, and Node reads a received value
    // back as Latin-1, so a key above U+007F can never match - `fetch` will not even send one. That
    // is now a request-time transport failure rather than a startup refusal: the owner's key is the
    // owner's business, and the cost is that this particular mistake surfaces later.
    assert.doesNotThrow(() => ApiCredential.fromKey('\u{1F511}'.repeat(8)));
  });

  test('only the absence of a key stops a programmatic caller', () => {
    // `serve` is importable, so the one rule there is has to live in the constructor rather than in
    // the loader, or it would be a rule about configuration files rather than about this server.
    assert.throws(() => ApiCredential.fromKey(''), ConfigurationError);
    assert.doesNotThrow(() => ApiCredential.fromKey('x'));
  });

  test('a credential does not become readable by being printed or serialized', () => {
    const credential = ApiCredential.fromKey(GOOD_KEY);
    assert.equal(`${credential}`, '[ApiCredential]');
    assert.equal(JSON.stringify({ credential }).includes(GOOD_KEY), false);
    assert.equal(JSON.stringify({ credential }), '{"credential":{}}');
    assert.equal(credential.matches(GOOD_KEY), true);
    assert.equal(credential.matches(`${GOOD_KEY}x`), false);
    // A token of a different length must be answered, not thrown at: both sides are hashed first.
    assert.equal(credential.matches(''), false);
  });

  test('the loaded result separates non-secret options from the credential', () => {
    withTempDir('config-split', (dir) => {
      const loaded = load({ dir, readEnvFile: false });
      assert.deepEqual(Object.keys(loaded).sort(), ['credential', 'options']);
      // Serializing the options - a diagnostic, a debug dump - cannot reach a credential.
      assert.equal(JSON.stringify(loaded.options).includes(GOOD_KEY), false);
    });
  });
});

describe('programmatic options', () => {
  const valid = {
    server: { host: '127.0.0.1', port: 0 },
    database: { databasePath: '/tmp/raphael-validate/raphael.sqlite', busyTimeoutMs: 5_000 },
    idempotency: { gcIntervalMinutes: 60, gcBatchSize: 500 },
  };

  test('an ephemeral port is allowed here, though a configuration file may not ask for one', () => {
    // A caller that passes 0 can read the bound address back, which is what finite integration tests
    // do. An operator's clients need a fixed address, so the file surface still refuses it.
    assert.doesNotThrow(() => validateOptions(valid));
  });

  test('every bound that applies to a file applies to a caller too', () => {
    const cases: [string, BackendOptions][] = [
      // SQLite reads a negative LIMIT as *no limit*, so this value would turn one bounded batch into
      // the whole backlog in a single transaction. It is the reason this function exists.
      ['negative batch size', { ...valid, idempotency: { ...valid.idempotency, gcBatchSize: -1 } }],
      ['zero batch size', { ...valid, idempotency: { ...valid.idempotency, gcBatchSize: 0 } }],
      ['huge batch size', { ...valid, idempotency: { ...valid.idempotency, gcBatchSize: 1e9 } }],
      ['zero interval', { ...valid, idempotency: { ...valid.idempotency, gcIntervalMinutes: 0 } }],
      ['negative busy timeout', { ...valid, database: { ...valid.database, busyTimeoutMs: -1 } }],
      ['port above range', { ...valid, server: { ...valid.server, port: 70_000 } }],
      ['negative port', { ...valid, server: { ...valid.server, port: -1 } }],
      ['fractional port', { ...valid, server: { ...valid.server, port: 80.5 } }],
      ['empty host', { ...valid, server: { ...valid.server, host: '' } }],
      ['host with a space', { ...valid, server: { ...valid.server, host: '127.0.0.1 ' } }],
      [
        'relative database path',
        { ...valid, database: { ...valid.database, databasePath: './x.db' } },
      ],
    ];
    for (const [label, options] of cases) {
      assert.throws(() => validateOptions(options), ConfigurationError, `${label} was accepted`);
    }
  });

  test("validation returns a snapshot, not the caller's object", () => {
    const options: BackendOptions = {
      server: { host: '127.0.0.1', port: 0 },
      database: { databasePath: '/tmp/raphael-validate/raphael.sqlite', busyTimeoutMs: 5_000 },
      idempotency: { gcIntervalMinutes: 60, gcBatchSize: 500 },
    };
    const validated = validateOptions(options);
    assert.notEqual(
      validated,
      options,
      'the caller must not keep a handle on what the server uses',
    );

    // Startup is asynchronous and the batch size is not read until after the listener is acquired, so
    // returning the caller's object would have left the check decorative. Measured against an earlier
    // version: this put -1 back into the delete statement.
    (options.idempotency as { gcBatchSize: number }).gcBatchSize = -1;
    (options.database as { databasePath: string }).databasePath = '/etc/passwd';
    (options.server as { port: number }).port = 70_000;

    assert.equal(validated.idempotency.gcBatchSize, 500);
    assert.equal(validated.database.databasePath, '/tmp/raphael-validate/raphael.sqlite');
    assert.equal(validated.server.port, 0);
  });

  test('a value is read once, so an accessor cannot answer differently the second time', () => {
    let reads = 0;
    const options: BackendOptions = {
      server: { host: '127.0.0.1', port: 0 },
      database: { databasePath: '/tmp/raphael-validate/raphael.sqlite', busyTimeoutMs: 5_000 },
      idempotency: {
        gcIntervalMinutes: 60,
        // Valid when inspected, unbounded afterwards.
        get gcBatchSize() {
          reads += 1;
          return reads === 1 ? 500 : -1;
        },
      },
    };

    const validated = validateOptions(options);
    assert.equal(reads, 1, "the caller's value must be read exactly once");
    assert.equal(validated.idempotency.gcBatchSize, 500);
    assert.equal(validated.idempotency.gcBatchSize, 500, 'the snapshot must be a plain value');
    assert.equal(reads, 1, "nothing may go back to the caller's object after validation");
  });

  test('serve refuses options it was handed rather than trusting them', async () => {
    const temp = tempDatabase('validate-serve');
    try {
      const outcome = await Effect.runPromiseExit(
        Effect.scoped(
          serve({
            options: {
              server: { host: '127.0.0.1', port: 0 },
              database: { databasePath: temp.file, busyTimeoutMs: 5_000 },
              idempotency: { gcIntervalMinutes: 60, gcBatchSize: -1 },
            },
            credential: ApiCredential.fromKey(GOOD_KEY),
            logger: silentLogger,
          }),
        ),
      );
      assert.equal(outcome._tag, 'Failure');
      // Refused before anything was acquired: the database is untouched and still openable.
      const reopened = openDatabase({ databasePath: temp.file, acquisitionTimeoutMs: 200 });
      reopened.close();
    } finally {
      temp.cleanup();
    }
  });

  test("serve reads the caller's options once and runs from the snapshot", async () => {
    const temp = tempDatabase('validate-serve-snapshot');
    const reads = { gcBatchSize: 0, databasePath: 0, port: 0 };
    try {
      const options: BackendOptions = {
        server: {
          host: '127.0.0.1',
          get port() {
            reads.port += 1;
            return 0;
          },
        },
        database: {
          get databasePath() {
            reads.databasePath += 1;
            return temp.file;
          },
          busyTimeoutMs: 5_000,
        },
        idempotency: {
          gcIntervalMinutes: 60,
          get gcBatchSize() {
            reads.gcBatchSize += 1;
            // Valid on the first read, unbounded on any later one. If startup went back to this
            // object - after acquiring the listener, where the collector is forked - SQLite would be
            // handed a negative LIMIT and one batch would become the whole backlog.
            return reads.gcBatchSize === 1 ? 500 : -1;
          },
        },
      };

      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(
            serve({
              options,
              credential: ApiCredential.fromKey(GOOD_KEY),
              logger: silentLogger,
            }),
            (running) =>
              Effect.sync(() => {
                assert.ok(running.port > 0);
              }),
          ),
        ),
      );

      assert.deepEqual(
        reads,
        { gcBatchSize: 1, databasePath: 1, port: 1 },
        'startup must read each supplied value exactly once and then use its own snapshot',
      );
    } finally {
      temp.cleanup();
    }
  });
});
