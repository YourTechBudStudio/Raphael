import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from '../src/distribution.ts';

/**
 * The CLI's own server command, as a real process.
 *
 * Testing this through the library would establish nothing about the part that is actually the CLI's:
 * holding the scope open, owning the signals the backend deliberately does not register, and choosing
 * exit codes. Those only exist in a process, so these tests spawn one and signal it.
 *
 * Every server started here is stopped here. Nothing is left running.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const binary = join(packageRoot, 'dist', 'main.js');
const KEY = 'test-key-0123456789abcdef0123456789';

const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

after(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolveExit) => {
        child.once('close', () => resolveExit());
        child.kill('SIGKILL');
      });
    }),
  );
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const workspace = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-serve-')));
  directories.push(directory);
  return directory;
};

interface Started {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

const startServe = (args: readonly string[], env: Record<string, string>, cwd: string): Started => {
  const child = spawn(process.execPath, [binary, 'server', 'serve', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    cwd,
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('close', (code) => resolveExit(code));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
};

/** Wait for a condition, with a bound so a failure is a failure rather than a hang. */
const waitFor = async (predicate: () => boolean, label: string, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
};

const configFile = (directory: string, body: string): string => {
  const path = join(directory, 'raphael.yaml');
  writeFileSync(path, body);
  return path;
};

describe('starting', () => {
  it('serves requests without remote configuration and shuts down cleanly on SIGINT', async () => {
    const directory = workspace();
    // A fixed port rather than 0: a configuration file may not ask for an ephemeral port, deliberately,
    // because an operator's clients need a fixed address to be configured against.
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39217\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );

    const started = startServe(
      ['--config', config],
      {
        RAPHAEL_SERVER_API_KEY: KEY,
        // The clients' variables are not the server's: neither the pair nor a saved login is read.
        RAPHAEL_ENDPOINT: 'http://not-a-real-host.invalid',
        RAPHAEL_API_KEY: 'not-the-server-key',
        XDG_CONFIG_HOME: '/nonexistent/relative',
      },
      directory,
    );
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    // A server produces no results, so every line it writes is an operator line on stderr: the
    // backend's log line, then a summary built from what was actually bound and opened.
    assert.match(started.stderr(), /server\.listening/);
    const summary = started.stderr().slice(started.stderr().indexOf('Raphael is running'));
    assert.equal(
      summary,
      [
        'Raphael is running at http://127.0.0.1:39217',
        `Database: ${join(directory, 'data', 'raphael.sqlite')}`,
        'API key:  RAPHAEL_SERVER_API_KEY from the environment',
        'Next: in another terminal, run "raphael login http://127.0.0.1:39217" and enter the same key.',
        'Press Ctrl-C to stop.',
        '',
      ].join('\n'),
    );

    const response = await fetch('http://127.0.0.1:39217/api/connection/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      protocolVersion: PROTOCOL_VERSION,
      raphaelVersion: version(),
    });

    // The backend registers no signal handler; this is the CLI's to own.
    started.child.kill('SIGINT');
    const code = await started.exited;

    assert.equal(code, 0, 'an orderly shutdown after a signal is a success');
    assert.match(started.stderr(), /^Shutting down\. Press Ctrl-C again to stop immediately\.$/m);
    assert.match(started.stderr(), /server\.stopped/);
    assert.equal(started.stdout(), '', 'nothing a reader is expected to keep');
  });

  it('shuts down cleanly on SIGTERM too', async () => {
    const directory = workspace();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39218\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_SERVER_API_KEY: KEY }, directory);
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');

    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 0);
    // Nothing to press under a supervisor.
    assert.match(
      started.stderr(),
      /^Received SIGTERM, shutting down\. Send it again to stop immediately\.$/m,
    );
  });

  it('reads the key from the .env beside --config, and flags override the file', async () => {
    const directory = workspace();
    const elsewhere = workspace();
    const config = configFile(directory, `server:\n  port: 39221\ndatabase:\n  path: ./a.sqlite\n`);
    writeFileSync(join(directory, '.env'), `RAPHAEL_SERVER_API_KEY=${KEY}\n`);
    const started = startServe(
      ['--config', config, '--port', '39222', '--database', 'b.sqlite'],
      {},
      elsewhere,
    );
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    assert.match(started.stderr(), /^Raphael is running at http:\/\/127\.0\.0\.1:39222$/m);
    assert.match(started.stderr(), new RegExp(`^Database: ${join(elsewhere, 'b.sqlite')}$`, 'm'));
    assert.match(
      started.stderr(),
      new RegExp(`^API key:  RAPHAEL_SERVER_API_KEY from ${join(directory, '.env')}$`, 'm'),
    );
    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 0);
  });

  it('says how to reach a server listening on every interface, and what that exposes', async () => {
    const directory = workspace();
    const started = startServe(
      ['--host', '0.0.0.0', '--port', '39223', '--database', './x.sqlite'],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    assert.match(
      started.stderr(),
      /^Raphael is running on every interface, port 39223\. From this machine: http:\/\/127\.0\.0\.1:39223$/m,
    );
    assert.match(
      started.stderr(),
      /^Other machines can reach it, and over http the key travels unencrypted\.$/m,
    );
    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 0);
  });
});

describe('a log reader that goes away', () => {
  it('does not stop the server, and the shutdown still drains and exits 0', async () => {
    // `raphael server serve 2>&1 | head -1`: the reader leaves after the first line. The shutdown
    // logs more lines after that, and a failed write must not crash the server mid-shutdown.
    const directory = workspace();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39219\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_SERVER_API_KEY: KEY }, directory);
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    started.child.stderr.destroy();
    started.child.stdout.destroy();

    // Still serving.
    const response = await fetch('http://127.0.0.1:39219/api/connection/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);

    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 0, 'the orderly shutdown ran to the end');
  });
});

describe('refusing to start', () => {
  it('treats a missing key as a setup problem, not an operation failure', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  host: 127.0.0.1\n  port: 39220\n`);
    const started = startServe(['--config', config], {}, directory);

    assert.equal(await started.exited, 5, 'a configuration problem is "not configured"');
    // With --config, the .env beside the file is the one checked, and the error names it.
    assert.equal(
      started.stderr(),
      `RAPHAEL_SERVER_API_KEY is not set in the environment or in "${join(directory, '.env')}". Raphael will not start without a key.\n` +
        `hint: Generate a key with "openssl rand -hex 32" and add RAPHAEL_SERVER_API_KEY=<key> to "${join(directory, '.env')}".\n`,
    );
  });

  it('reports an invalid configuration file with its typed reason', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  port: 70000\n`);
    const started = startServe(['--config', config], { RAPHAEL_SERVER_API_KEY: KEY }, directory);

    assert.equal(await started.exited, 5);
    assert.match(started.stderr(), /^hint: /m);
    assert.equal(started.stderr().includes(KEY), false);
    assert.equal(started.stdout().includes(KEY), false);
  });

  it('reports an unreadable configuration file', async () => {
    const directory = workspace();
    const started = startServe(
      ['--config', join(directory, 'absent.yaml')],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    assert.equal(await started.exited, 5);
    assert.match(started.stderr(), /absent\.yaml/);
  });
});

describe('failing to start', () => {
  it('reports a port in use in one sentence, and creates no database', async () => {
    const directory = workspace();
    const blocker = createNetServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
    const { port } = blocker.address() as AddressInfo;
    try {
      const started = startServe(
        ['--port', String(port), '--database', './data/raphael.sqlite'],
        { RAPHAEL_SERVER_API_KEY: KEY },
        directory,
      );
      assert.equal(await started.exited, 5);
      assert.equal(
        started.stderr(),
        `Port ${port} on 127.0.0.1 is already in use. Nothing was created.\n` +
          'hint: Stop whatever is using it, or choose another port with --port or server.port.\n',
      );
      assert.equal(existsSync(join(directory, 'data')), false, 'no database directory was created');
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });

  it('reports a database path it cannot write, with no stack, and leaves nothing listening', async () => {
    const directory = workspace();
    const started = startServe(
      ['--port', '39224', '--database', directory],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    assert.equal(await started.exited, 5);
    assert.equal(
      started.stderr(),
      `Cannot open the database at "${directory}": it is a directory.\n` +
        'hint: Set --database or database.path to a file path you can write.\n',
    );
    await assert.rejects(fetch('http://127.0.0.1:39224/'), 'nothing is left listening');
  });

  it('refuses flag values as a mistake in the command, by flag name, before looking for a key', async () => {
    const directory = workspace();
    const started = startServe(['--port', 'abc', '--host', ''], {}, directory);
    assert.equal(await started.exited, 2);
    assert.equal(
      started.stderr(),
      'The server serve options are not valid:\n' +
        '  --host: must be a non-empty address with no spaces or control characters.\n' +
        '  --port: must be a number, got "abc".\n' +
        'hint: Run "raphael server serve --help" for usage.\n',
    );
  });

  it('reports a mistyped --config as itself, not as a missing key', async () => {
    const directory = workspace();
    const started = startServe(
      ['--config', join(directory, 'nope', 'raphael.yaml')],
      {},
      directory,
    );
    assert.equal(await started.exited, 5);
    assert.match(
      started.stderr(),
      /^Cannot read the configuration file ".*nope\/raphael\.yaml": it does not exist\.$/m,
    );
  });

  it('words a database path that runs through a file', async () => {
    const directory = workspace();
    writeFileSync(join(directory, 'plain-file'), '');
    const started = startServe(
      ['--port', '39225', '--database', join(directory, 'plain-file', 'raphael.sqlite')],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    assert.equal(await started.exited, 5);
    assert.match(started.stderr(), /: part of the path is not a directory\.$/m);
    assert.doesNotMatch(started.stderr(), /EEXIST|mkdir/);
  });
});

describe('what help says about the server', () => {
  it('restates the backend constants exactly', async () => {
    // Help renders without loading the backend, so it restates these; this keeps the copies honest.
    const backend = await import('@raphael/backend');
    const { SERVE_DEFAULTS } = await import('../src/modules/server/serve.ts');
    const { SERVER_API_KEY_VARIABLE } = await import('../src/shared/variables.ts');
    assert.deepEqual(SERVE_DEFAULTS, backend.CONFIG_DEFAULTS);
    assert.equal(SERVER_API_KEY_VARIABLE, backend.API_KEY_VARIABLE);
  });
});

describe('startup failure wording', () => {
  it('gives each failure one sentence, a next step, and an exit code', async () => {
    const { startupFailure } = await import('../src/modules/server/serve.ts');
    const at = { host: '127.0.0.1', port: 80, databasePath: '/srv/raphael.sqlite' };
    const cases: ReadonlyArray<
      readonly [
        stage: 'listen' | 'database',
        code: string | undefined,
        cause: unknown,
        expect: readonly [string, number, string],
      ]
    > = [
      [
        'listen',
        'EADDRINUSE',
        undefined,
        ['port_in_use', 5, 'Port 80 on 127.0.0.1 is already in use. Nothing was created.'],
      ],
      [
        'listen',
        'EACCES',
        undefined,
        [
          'listen_denied',
          5,
          'Cannot listen on 127.0.0.1:80: permission denied. Nothing was created.',
        ],
      ],
      [
        'listen',
        'EADDRNOTAVAIL',
        undefined,
        [
          'host_unavailable',
          5,
          '127.0.0.1 is not an address on this machine. Nothing was created.',
        ],
      ],
      [
        'listen',
        'EWHAT',
        new Error('odd failure'),
        ['listen_failed', 1, 'Cannot listen on 127.0.0.1:80: odd failure. Nothing was created.'],
      ],
      [
        'database',
        'database_in_use',
        undefined,
        [
          'database_in_use',
          5,
          'The database at "/srv/raphael.sqlite" is already in use by another process, such as another Raphael server.',
        ],
      ],
      [
        'database',
        'migration_history',
        undefined,
        [
          'database_newer',
          5,
          'The database at "/srv/raphael.sqlite" was migrated by a newer or different Raphael release.',
        ],
      ],
      [
        'database',
        'EACCES',
        Object.assign(new Error('x'), { code: 'EACCES' }),
        [
          'database_unusable',
          5,
          'Cannot open the database at "/srv/raphael.sqlite": permission denied.',
        ],
      ],
      [
        'database',
        'MODULE_NOT_FOUND',
        new Error("Cannot find module '/x/better_sqlite3.node'\nRequire stack:\n- /y"),
        [
          'database_unusable',
          1,
          'Cannot open the database at "/srv/raphael.sqlite": Cannot find module \'/x/better_sqlite3.node\'.',
        ],
      ],
    ];
    for (const [stage, code, cause, [failureCode, exitCode, message]] of cases) {
      const failure = startupFailure({ stage, code, cause, ...at });
      assert.equal(failure.code, failureCode, `${stage} ${code}`);
      assert.equal(failure.exitCode, exitCode, `${stage} ${code}`);
      assert.equal(failure.message, message);
      assert.equal(failure.message.includes('\n'), false, 'one line');
      assert.notEqual(failure.hint, '');
    }
  });
});

describe('the documented key file recipe', () => {
  it('creates an owner-only .env, and tightens one that already existed', async () => {
    const { spawnSync } = await import('node:child_process');
    const { statSync, chmodSync: chmod } = await import('node:fs');
    const { SERVER_KEY_FILE_RECIPE } = await import('../src/shared/variables.ts');
    const directory = workspace();
    const run = (): void => {
      // The usual umask, under which a plain `>` would create a world-readable file. `echo` is
      // replaced by a function that refuses to write unless .env is already exactly 0600, so the
      // mode is checked at the moment the key is written, not only afterwards.
      const guard =
        'echo() { [ -n "$(find .env -perm 0600)" ] || { printf "unprotected at write\\n" >&2; exit 9; }; printf "%s\\n" "$*"; }';
      const ran = spawnSync('/bin/sh', ['-c', `umask 022; ${guard}; ${SERVER_KEY_FILE_RECIPE}`], {
        cwd: directory,
      });
      assert.equal(ran.status, 0, String(ran.stderr));
    };
    run();
    assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
    chmod(join(directory, '.env'), 0o644);
    run();
    assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
    assert.match(
      readFileSync(join(directory, '.env'), 'utf8'),
      /^RAPHAEL_SERVER_API_KEY=[0-9a-f]{64}\n$/u,
    );
  });
});
