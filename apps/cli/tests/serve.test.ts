import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from '../src/distribution.ts';
import type { Ran } from './support/cli.ts';
import { goldenSurface } from './support/golden.ts';

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
// The source, as every other in-repository test runs it, so the copy asserted here is the copy in
// the working tree rather than whatever was last built.
const main = join(packageRoot, 'src', 'main.ts');
const KEY = 'test-key-0123456789abcdef0123456789';
const serveGoldens = goldenSurface('serve');

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
  const child = spawn(process.execPath, [main, 'server', 'serve', ...args], {
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

/**
 * A port nothing is listening on, chosen by the system: bound on port 0, read, and released. Serve
 * refuses port 0 (an operator's clients need a fixed address), so a test asks for this one instead
 * of a number of its own that something else on the machine may hold.
 */
const freePort = async (host = '127.0.0.1'): Promise<number> => {
  const probe = createNetServer();
  await new Promise<void>((resolveListen) => probe.listen(0, host, resolveListen));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
};

const configFile = (directory: string, body: string): string => {
  const path = join(directory, 'raphael.yaml');
  writeFileSync(path, body);
  return path;
};

describe('starting', () => {
  it('serves requests without remote configuration and shuts down cleanly on SIGINT', async () => {
    const directory = workspace();
    // Not 0: a configuration file may not ask for an ephemeral port, deliberately, because an
    // operator's clients need a fixed address to be configured against.
    const port = await freePort();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: ${port}\ndatabase:\n  path: ./data/raphael.sqlite\n`,
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
        `Raphael is running at http://127.0.0.1:${port}`,
        `Database: ${join(directory, 'data', 'raphael.sqlite')}`,
        'API key:  RAPHAEL_SERVER_API_KEY from the environment',
        `hint: In another terminal, run "raphael login http://127.0.0.1:${port}" and enter the same key.`,
        'Press Ctrl-C to stop.',
        '',
      ].join('\n'),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/connection/verify`, {
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

    assert.equal(code, 130, 'an orderly shutdown after SIGINT exits as interrupted by it');
    assert.match(started.stderr(), /^Shutting down\. Press Ctrl-C again to stop immediately\.$/m);
    assert.match(started.stderr(), /server\.stopped/);
    assert.equal(started.stdout(), '', 'nothing a reader is expected to keep');
  });

  it('shuts down cleanly on SIGTERM too', async () => {
    const directory = workspace();
    const port = await freePort();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: ${port}\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_SERVER_API_KEY: KEY }, directory);
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');

    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 143);
    // Nothing to press under a supervisor.
    assert.match(
      started.stderr(),
      /^Received SIGTERM, shutting down\. Send it again to stop immediately\.$/m,
    );
  });

  it('reads the key from the .env beside --config, and flags override the file', async () => {
    const directory = workspace();
    const elsewhere = workspace();
    const [filePort, flagPort] = [await freePort(), await freePort()];
    const config = configFile(
      directory,
      `server:\n  port: ${filePort}\ndatabase:\n  path: ./a.sqlite\n`,
    );
    writeFileSync(join(directory, '.env'), `RAPHAEL_SERVER_API_KEY=${KEY}\n`);
    const started = startServe(
      ['--config', config, '--port', String(flagPort), '--database', 'b.sqlite'],
      {},
      elsewhere,
    );
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    assert.ok(
      started.stderr().includes(`\nRaphael is running at http://127.0.0.1:${flagPort}\n`),
      started.stderr(),
    );
    assert.match(started.stderr(), new RegExp(`^Database: ${join(elsewhere, 'b.sqlite')}$`, 'm'));
    assert.match(
      started.stderr(),
      new RegExp(`^API key:  RAPHAEL_SERVER_API_KEY from ${join(directory, '.env')}$`, 'm'),
    );
    // Written with the usual umask, so other users can read it, and the operator is told so.
    assert.ok(
      started
        .stderr()
        .includes(
          `warning: Other users of this machine can read ${join(directory, '.env')}, which holds the key. Run "chmod 600 ${join(directory, '.env')}".\n`,
        ),
    );
    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 143);
  });

  it('says how to reach a server listening on every interface, and what that exposes', async () => {
    const directory = workspace();
    const port = await freePort('0.0.0.0');
    const started = startServe(
      ['--host', '0.0.0.0', '--port', String(port), '--database', './x.sqlite'],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    assert.ok(
      started
        .stderr()
        .includes(
          `\nRaphael is running on every interface, port ${port}. From this machine: http://127.0.0.1:${port}\n`,
        ),
      started.stderr(),
    );
    assert.match(
      started.stderr(),
      /^Other machines can reach it, and over http the key travels unencrypted\.$/m,
    );
    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 143);
  });
});

describe('a log reader that goes away', () => {
  it('does not stop the server, and the shutdown still drains and exits 143', async () => {
    // `raphael server serve 2>&1 | head -1`: the reader leaves after the first line. The shutdown
    // logs more lines after that, and a failed write must not crash the server mid-shutdown.
    const directory = workspace();
    const port = await freePort();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: ${port}\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_SERVER_API_KEY: KEY }, directory);
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    started.child.stderr.destroy();
    started.child.stdout.destroy();

    // Still serving.
    const response = await fetch(`http://127.0.0.1:${port}/api/connection/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);

    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 143, 'the orderly shutdown ran to the end');
  });
});

describe('refusing to start', () => {
  it('treats a missing key as a setup problem, not an operation failure', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  host: 127.0.0.1\n  port: ${await freePort()}\n`);
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
        `Port ${port} on 127.0.0.1 is already in use.\n` +
          'Nothing was created.\n' +
          'hint: Stop whatever is using it, or choose another port with --port or server.port.\n',
      );
      assert.equal(existsSync(join(directory, 'data')), false, 'no database directory was created');
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });

  it('reports a database path it cannot write, with no stack, and leaves nothing listening', async () => {
    const directory = workspace();
    const port = await freePort();
    const started = startServe(
      ['--port', String(port), '--database', directory],
      { RAPHAEL_SERVER_API_KEY: KEY },
      directory,
    );
    assert.equal(await started.exited, 5);
    assert.equal(
      started.stderr(),
      `Cannot open the database at "${directory}": it is a directory.\n` +
        'hint: Set --database or database.path to a file path you can write.\n',
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), 'nothing is left listening');
  });

  it('refuses flag values as a mistake in the command, by flag name, before looking for a key', async () => {
    const directory = workspace();
    const started = startServe(['--host', '', '--database', ' '], {}, directory);
    assert.equal(await started.exited, 2);
    assert.equal(
      started.stderr(),
      'The server serve options are not valid:\n' +
        '  --host: must be a non-empty address with no spaces or control characters.\n' +
        '  --database: must be a non-empty path with no control characters.\n' +
        'hint: Run "raphael server serve --help" for usage.\n',
    );
  });

  it('refuses a port by the rule every whole-number flag states, never restating the value', async () => {
    const directory = workspace();
    for (const port of ['abc', '1e3', '3000.0', '1.5', '0', '70000', '99999999999999999999']) {
      for (const argv of [['--port', port], [`--port=${port}`]]) {
        const started = startServe(argv, {}, directory);
        assert.equal(await started.exited, 2, port);
        assert.equal(
          started.stderr(),
          '--port must be a whole number between 1 and 65535.\n' +
            'hint: Run "raphael server serve --help" for usage.\n',
          port,
        );
      }
    }
  });

  it('refuses a host that is a URL, carries a port or brackets, as a mistake in the command', async () => {
    const directory = workspace();
    for (const host of ['http://127.0.0.1', '127.0.0.1:3000', '[::1]', '999.1.1.1']) {
      const started = startServe(['--host', host], {}, directory);
      assert.equal(await started.exited, 2, host);
      assert.match(started.stderr(), /^ {2}--host: must be /mu, host);
    }
  });

  it('states the port range for a negative port, spaced or inline', async () => {
    // --port -1 used to advise --port=-1, which then said -1 was not a number.
    const directory = workspace();
    const inline = startServe(['--port=-1'], {}, directory);
    assert.equal(await inline.exited, 2);
    assert.equal(
      inline.stderr(),
      '--port must be a whole number between 1 and 65535.\n' +
        'hint: Run "raphael server serve --help" for usage.\n',
    );
    const spaced = startServe(['--port', '-1'], {}, directory);
    assert.equal(await spaced.exited, 2);
    assert.equal(
      spaced.stderr(),
      '--port must be a whole number between 1 and 65535.\n' +
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
      ['--port', String(await freePort()), '--database', join(directory, 'plain-file', 'raphael.sqlite')],
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
    const { SERVE_DEFAULTS, SERVE_PORT_RANGE } = await import('../src/modules/server/serve.ts');
    const { SERVER_API_KEY_VARIABLE } = await import('../src/shared/variables.ts');
    assert.deepEqual(SERVE_DEFAULTS, backend.CONFIG_DEFAULTS);
    assert.deepEqual(SERVE_PORT_RANGE, backend.CONFIGURED_PORT_RANGE);
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
        ['port_in_use', 5, 'Port 80 on 127.0.0.1 is already in use.'],
      ],
      [
        'listen',
        'EACCES',
        undefined,
        ['listen_denied', 5, 'Cannot listen on 127.0.0.1:80: permission denied.'],
      ],
      [
        'listen',
        'EADDRNOTAVAIL',
        undefined,
        ['host_unavailable', 5, '127.0.0.1 is not an address on this machine.'],
      ],
      [
        'listen',
        'EWHAT',
        new Error('odd failure'),
        ['listen_failed', 1, 'Cannot listen on 127.0.0.1:80: odd failure.'],
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
        new Error("Cannot find module 'drizzle-orm/better-sqlite3'\nRequire stack:\n- /y"),
        [
          'database_unusable',
          1,
          'Cannot open the database at "/srv/raphael.sqlite": Cannot find module \'drizzle-orm/better-sqlite3\'.',
        ],
      ],
    ];
    for (const [stage, code, cause, [failureCode, exitCode, message]] of cases) {
      const failure = startupFailure({ stage, code, cause, ...at });
      assert.equal(failure.code, failureCode, `${stage} ${code}`);
      assert.equal(failure.exitCode, exitCode, `${stage} ${code}`);
      assert.equal(failure.message, message);
      assert.equal(failure.message.includes('\n'), false, 'one line');
      // A listener that failed created nothing, said on its own line; a database failure may have.
      assert.equal(
        failure.stateLine,
        stage === 'listen' ? 'Nothing was created.' : undefined,
        `${stage} ${code}`,
      );
      assert.notEqual(failure.hint, '');
    }
  });
});

/**
 * Every way `server serve` can fail to start, pinned as it prints. Each failure the system can be made
 * to produce here is a real run; the rest (a port this user may not bind, a damaged database, a cause
 * nothing explains) are rendered from the failure the backend would report.
 */
describe('startup failure goldens', () => {
  const scrubbed = (ran: Ran, root: string, port?: number): Ran => {
    const clean = (text: string): string => {
      const rooted = text.replaceAll(root, '<tmp>');
      return port === undefined ? rooted : rooted.replaceAll(String(port), '<port>');
    };
    return { code: ran.code, stdout: clean(ran.stdout), stderr: clean(ran.stderr) };
  };

  const failToStart = async (args: readonly string[], directory: string): Promise<Ran> => {
    const started = startServe(args, { RAPHAEL_SERVER_API_KEY: KEY }, directory);
    const code = await started.exited;
    return { code, stdout: started.stdout(), stderr: started.stderr() };
  };

  it('a port in use', async () => {
    const directory = workspace();
    const blocker = createNetServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
    const { port } = blocker.address() as AddressInfo;
    try {
      const ran = await failToStart(
        ['--port', String(port), '--database', './x.sqlite'],
        directory,
      );
      assert.equal(ran.code, 5);
      serveGoldens.expectRun('port-in-use', scrubbed(ran, directory, port));
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });

  it('a host this machine does not have', async () => {
    const directory = workspace();
    // TEST-NET-1 (RFC 5737): never assigned to an interface.
    const ran = await failToStart(['--host', '192.0.2.1', '--port', String(await freePort())], directory);
    assert.equal(ran.code, 5);
    serveGoldens.expectRun('host-unavailable', scrubbed(ran, directory));
  });

  it('a database another process holds', async () => {
    const directory = workspace();
    const path = join(directory, 'held.sqlite');
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN EXCLUSIVE; CREATE TABLE held (x); ');
    try {
      const ran = await failToStart(['--port', String(await freePort()), '--database', path], directory);
      assert.equal(ran.code, 5);
      serveGoldens.expectRun('database-in-use', scrubbed(ran, directory));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('a database a newer release migrated', async () => {
    const directory = workspace();
    const path = join(directory, 'newer.sqlite');
    const newer = new DatabaseSync(path);
    newer.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);' +
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 4102444800000);",
    );
    newer.close();
    const ran = await failToStart(['--port', String(await freePort()), '--database', path], directory);
    assert.equal(ran.code, 5);
    serveGoldens.expectRun('database-newer', scrubbed(ran, directory));
  });

  it('a database whose tables do not match the migrations it records', async () => {
    const directory = workspace();
    const path = join(directory, 'partial.sqlite');
    const journal = JSON.parse(
      readFileSync(
        resolve(packageRoot, '..', 'backend', 'drizzle', 'meta', '_journal.json'),
        'utf8',
      ),
    ) as { entries: { when: number }[] };
    // The first migration recorded as applied, and none of its tables there: the next one fails.
    const partial = new DatabaseSync(path);
    partial.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC);' +
        `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ${journal.entries[0]?.when});`,
    );
    partial.close();
    const ran = await failToStart(['--port', String(await freePort()), '--database', path], directory);
    assert.equal(ran.code, 5);
    assert.doesNotMatch(ran.stderr, /query|SQL|Reinstall/u);
    serveGoldens.expectRun('database-partly-migrated', scrubbed(ran, directory));
  });

  it('database paths that cannot hold a Raphael database', async () => {
    const directory = workspace();
    writeFileSync(join(directory, 'plain-file'), '');
    writeFileSync(join(directory, 'notes.txt'), 'DATABASE_URL=postgres://keep-me\n');
    symlinkSync(join(directory, 'nowhere'), join(directory, 'dangling'));
    mkdirSync(join(directory, 'locked'), { mode: 0o500 });
    // Another application's database: valid SQLite, with tables and no Raphael migration history.
    const other = new DatabaseSync(join(directory, 'other.sqlite'));
    other.exec(
      'CREATE TABLE invoices (id INTEGER, amount INTEGER); INSERT INTO invoices VALUES (1, 100);',
    );
    other.close();
    const otherBytes = readFileSync(join(directory, 'other.sqlite'));
    const cases: ReadonlyArray<readonly [name: string, database: string]> = [
      ['database-directory', directory],
      ['database-path-through-file', join(directory, 'plain-file', 'raphael.sqlite')],
      ['database-path-missing', join(directory, 'dangling', 'raphael.sqlite')],
      ['database-not-writable', join(directory, 'locked', 'raphael.sqlite')],
      ['database-not-sqlite', join(directory, 'notes.txt')],
      ['database-foreign', join(directory, 'other.sqlite')],
      ['database-device', '/dev/null'],
    ];
    try {
      for (const [name, database] of cases) {
        const ran = await failToStart(['--port', String(await freePort()), '--database', database], directory);
        assert.equal(ran.code, 5, name);
        assert.doesNotMatch(ran.stderr, /ENOENT|EACCES|mkdir|SQLITE|Reinstall/u, name);
        serveGoldens.expectRun(name, scrubbed(ran, directory));
      }
      assert.equal(
        readFileSync(join(directory, 'notes.txt'), 'utf8'),
        'DATABASE_URL=postgres://keep-me\n',
        'a file that is not a database is left as it was',
      );
      assert.equal(existsSync(join(directory, 'nowhere')), false, 'a link to nowhere stays one');
      assert.deepEqual(
        readFileSync(join(directory, 'other.sqlite')),
        otherBytes,
        "another application's database is left byte for byte as it was",
      );
    } finally {
      chmodSync(join(directory, 'locked'), 0o700);
    }
  });

  it('failures that cannot be produced here, as the backend reports them', async () => {
    const { startupFailure } = await import('../src/modules/server/serve.ts');
    const { renderFailure } = await import('../src/shared/failure.ts');
    const { newSession } = await import('../src/shared/command.ts');
    const at = { host: '127.0.0.1', port: 80, databasePath: '/srv/raphael.sqlite' };
    const systemError = (code: string, message: string): Error =>
      Object.assign(new Error(message), { code });
    const cases: ReadonlyArray<
      readonly [name: string, stage: 'listen' | 'database', code: string, cause: unknown]
    > = [
      ['listen-denied', 'listen', 'EACCES', systemError('EACCES', 'listen EACCES')],
      ['listen-unexplained', 'listen', 'EWHAT', new Error('odd failure')],
      [
        'database-damaged',
        'database',
        'SQLITE_CORRUPT',
        systemError('SQLITE_CORRUPT', 'database disk image is malformed'),
      ],
      [
        'database-unexplained',
        'database',
        'MODULE_NOT_FOUND',
        new Error("Cannot find module 'drizzle-orm/better-sqlite3'\nRequire stack:\n- /y"),
      ],
    ];
    for (const [name, stage, code, cause] of cases) {
      let stderr = '';
      const exitCode = renderFailure(
        { out: () => assert.fail('nothing on stdout'), err: (text) => (stderr += text) },
        newSession({ command: 'server serve', json: false, writes: false }),
        startupFailure({ stage, code, cause, ...at }),
      );
      serveGoldens.expectRun(name, { code: exitCode, stdout: '', stderr });
    }
  });

  it('every configuration reason, as the operator meets it', async () => {
    // Each case: a name, what the directory holds, the arguments, and the key in the environment.
    const cases: ReadonlyArray<
      readonly [
        name: string,
        code: string,
        exit: number,
        setup: (directory: string) => readonly string[],
        key?: string,
      ]
    > = [
      ['config-unreadable', 'config_unreadable', 5, (d) => ['--config', join(d, 'absent.yaml')]],
      [
        'config-too-large',
        'config_too_large',
        5,
        (d) => ['--config', configFile(d, `# ${'x'.repeat(70 * 1024)}\n`)],
      ],
      [
        'config-malformed',
        'config_malformed',
        5,
        (d) => ['--config', configFile(d, 'server: [\n')],
      ],
      ['config-malformed-empty', 'config_malformed', 5, (d) => ['--config', configFile(d, '')]],
      [
        'config-unsafe',
        'config_unsafe',
        5,
        (d) => ['--config', configFile(d, 'server: &a\n  port: 3001\n')],
      ],
      [
        // The hint repeats the command as typed, so running it again starts the same server.
        'config-invalid',
        'config_invalid',
        5,
        (d) => [
          '--config',
          configFile(d, 'server:\n  prot: 1\n  port: 99999\n'),
          '--database',
          join(d, 'x.sqlite'),
        ],
      ],
      [
        'env-unreadable-directory',
        'env_unreadable',
        5,
        (d) => {
          mkdirSync(join(d, '.env'));
          return ['--config', configFile(d, 'server:\n  port: 3001\n')];
        },
      ],
      [
        'env-too-large',
        'env_too_large',
        5,
        (d) => {
          writeFileSync(join(d, '.env'), `# ${'x'.repeat(70 * 1024)}\n`, { mode: 0o600 });
          return ['--config', configFile(d, 'server:\n  port: 3001\n')];
        },
      ],
      [
        'api-key-missing',
        'api_key_missing',
        5,
        (d) => ['--config', configFile(d, 'server:\n  port: 3001\n')],
        '',
      ],
      ['api-key-unsendable', 'api_key_unsendable', 5, () => [], 'two words'],
      ['option-invalid-host', 'option_invalid', 2, () => ['--host', '']],
      ['option-invalid-config', 'option_invalid', 2, () => ['--config', '']],
    ];
    for (const [name, code, exit, setup, key] of cases) {
      const directory = workspace();
      const args = setup(directory);
      const started = startServe(
        args,
        key === '' ? {} : { RAPHAEL_SERVER_API_KEY: key ?? KEY },
        directory,
      );
      const ran: Ran = { code: await started.exited, stdout: '', stderr: started.stderr() };
      assert.equal(ran.code, exit, name);
      assert.equal(started.stdout(), '', name);
      serveGoldens.expectRun(name, scrubbed(ran, directory));
      // The text form carries no code, so the code is pinned from the backend's own reason.
      const { loadConfiguration, ConfigurationError } = await import('@raphael/backend');
      const { parseServeArgs } = await import('../src/modules/server/serve.ts');
      const parsed = parseServeArgs(args);
      assert.throws(
        () =>
          loadConfiguration({
            ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
            cwd: directory,
            overrides: parsed.overrides,
            processEnv: key === '' ? {} : { RAPHAEL_SERVER_API_KEY: key ?? KEY },
          }),
        (error) => error instanceof ConfigurationError && error.reason === code,
        name,
      );
    }
  });

  it('a failure to start the backend does not name', async () => {
    const { START_FAILED } = await import('../src/modules/server/serve.ts');
    const { renderFailure } = await import('../src/shared/failure.ts');
    const { newSession } = await import('../src/shared/command.ts');
    let stderr = '';
    const exitCode = renderFailure(
      { out: () => assert.fail('nothing on stdout'), err: (text) => (stderr += text) },
      newSession({ command: 'server serve', json: false, writes: false }),
      START_FAILED,
    );
    serveGoldens.expectRun('start-failed', { code: exitCode, stdout: '', stderr });
  });

  after(() => assert.deepEqual(serveGoldens.strays(), []));
});

describe('a .env key cut short by a comment', () => {
  it('starts, and warns that the key stops at the "#"', async () => {
    const directory = workspace();
    writeFileSync(join(directory, '.env'), `RAPHAEL_SERVER_API_KEY=${KEY}#rest\n`, { mode: 0o600 });
    const started = startServe(['--port', String(await freePort()), '--database', './x.sqlite'], {}, directory);
    await waitFor(() => started.stderr().includes('Press Ctrl-C'), 'the server to be ready');
    assert.ok(
      started
        .stderr()
        .includes(
          `warning: In ${join(directory, '.env')}, RAPHAEL_SERVER_API_KEY has a "#" that starts a comment, so the key stops before it. Quote the value to keep the "#".\n`,
        ),
    );
    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 143);
  });

  it('says nothing for a quoted value or a comment after a space', async () => {
    const { loadConfiguration } = await import('@raphael/backend');
    for (const line of [`"${KEY}#rest"`, `'${KEY}#rest'`, `${KEY} # the key`]) {
      const directory = workspace();
      writeFileSync(join(directory, '.env'), `RAPHAEL_SERVER_API_KEY=${line}\n`, { mode: 0o600 });
      const loaded = loadConfiguration({ cwd: directory, processEnv: {} });
      assert.equal(loaded.keySource.cutAtComment, false, line);
    }
  });
});

describe('the documented key file recipe', () => {
  it('creates an owner-only .env, and never replaces one that exists', async () => {
    const { spawnSync } = await import('node:child_process');
    const { lstatSync, statSync } = await import('node:fs');
    const { SERVER_KEY_FILE_RECIPE } = await import('../src/shared/variables.ts');
    const run = (
      directory: string,
    ): { readonly status: number | null; readonly stderr: string } => {
      // The usual umask, under which a plain `>` would create a world-readable file. `echo` is
      // replaced by a function that refuses to write a key unless .env is already exactly 0600, so
      // the mode is checked at the moment the key is written, not only afterwards.
      const guard =
        'echo() { case "$*" in RAPHAEL_SERVER_API_KEY=*) [ -n "$(find .env -perm 0600)" ] || { printf "unprotected at write\\n" >&2; exit 9; };; esac; printf "%s\\n" "$*"; }';
      const ran = spawnSync('/bin/sh', ['-c', `umask 022; ${guard}; ${SERVER_KEY_FILE_RECIPE}`], {
        cwd: directory,
        encoding: 'utf8',
      });
      return { status: ran.status, stderr: ran.stderr };
    };

    const fresh = workspace();
    const created = run(fresh);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stderr, '');
    assert.equal(statSync(join(fresh, '.env')).mode & 0o777, 0o600);
    assert.match(
      readFileSync(join(fresh, '.env'), 'utf8'),
      /^RAPHAEL_SERVER_API_KEY=[0-9a-f]{64}\n$/u,
    );

    // Another setting, or the key clients already log in with: both must survive.
    const existing = workspace();
    const kept = 'DATABASE_URL=postgres://keep-me\nRAPHAEL_SERVER_API_KEY=already-in-use\n';
    writeFileSync(join(existing, '.env'), kept, { mode: 0o644 });
    const refused = run(existing);
    assert.equal(
      refused.stderr,
      '.env already exists; add RAPHAEL_SERVER_API_KEY to it yourself.\n',
    );
    assert.equal(readFileSync(join(existing, '.env'), 'utf8'), kept);
    assert.equal(statSync(join(existing, '.env')).mode & 0o777, 0o644, 'not even its mode changes');

    // A dangling link is not followed to create a file somewhere else.
    const linked = workspace();
    symlinkSync(join(linked, 'elsewhere'), join(linked, '.env'));
    const dangling = run(linked);
    assert.notEqual(dangling.status, 0);
    assert.equal(existsSync(join(linked, 'elsewhere')), false);
    assert.equal(lstatSync(join(linked, '.env')).isSymbolicLink(), true);
  });
});
