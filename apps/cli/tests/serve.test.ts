import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

after(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
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
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolveExit) =>
    child.on('close', (code) => resolveExit(code)),
  );
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
  it('listens, reports where, and shuts down cleanly on SIGINT', async () => {
    const directory = workspace();
    // A fixed port rather than 0: a configuration file may not ask for an ephemeral port, deliberately,
    // because an operator's clients need a fixed address to be configured against.
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39217\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );

    const started = startServe(['--config', config], { RAPHAEL_API_KEY: KEY }, directory);
    await waitFor(() => started.stdout().includes('Press Ctrl-C'), 'the server to be ready');
    // The address is reported by the backend's startup log, which the CLI does not duplicate.
    assert.match(started.stdout(), /server\.listening/);
    assert.match(started.stdout(), /port=39217/);

    // The backend registers no signal handler; this is the CLI's to own.
    started.child.kill('SIGINT');
    const code = await started.exited;

    assert.equal(code, 0, 'an orderly shutdown after a signal is a success');
    assert.match(started.stderr(), /Received SIGINT, shutting down/);
  });

  it('shuts down cleanly on SIGTERM too', async () => {
    const directory = workspace();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39218\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_API_KEY: KEY }, directory);
    await waitFor(() => started.stdout().includes('Press Ctrl-C'), 'the server to be ready');

    started.child.kill('SIGTERM');
    assert.equal(await started.exited, 0);
  });

  it('answers requests while it is running', async () => {
    const directory = workspace();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39219\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(['--config', config], { RAPHAEL_API_KEY: KEY }, directory);
    await waitFor(() => started.stdout().includes('Press Ctrl-C'), 'the server to be ready');

    const response = await fetch('http://127.0.0.1:39219/api/connection/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { protocolVersion: 1 });

    started.child.kill('SIGINT');
    await started.exited;
  });
});

describe('refusing to start', () => {
  it('treats a missing key as a setup problem, not an operation failure', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  host: 127.0.0.1\n  port: 39220\n`);
    const started = startServe(['--config', config], {}, directory);

    assert.equal(await started.exited, 2, 'a configuration problem is a local setup failure');
    assert.match(started.stderr(), /RAPHAEL_API_KEY/);
    assert.match(started.stderr(), /reason: api_key_missing/);
  });

  it('reports an invalid configuration file with its typed reason', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  port: 70000\n`);
    const started = startServe(['--config', config], { RAPHAEL_API_KEY: KEY }, directory);

    assert.equal(await started.exited, 2);
    assert.match(started.stderr(), /reason: config_invalid/);
  });

  it('reports an unreadable configuration file', async () => {
    const directory = workspace();
    const started = startServe(
      ['--config', join(directory, 'absent.yaml')],
      { RAPHAEL_API_KEY: KEY },
      directory,
    );
    assert.equal(await started.exited, 2);
    assert.match(started.stderr(), /reason: config_unreadable/);
  });

  it('never prints the key, whatever it refuses', async () => {
    const directory = workspace();
    const config = configFile(directory, `server:\n  port: 70000\n`);
    const started = startServe(['--config', config], { RAPHAEL_API_KEY: KEY }, directory);
    await started.exited;
    assert.equal(started.stderr().includes(KEY), false);
    assert.equal(started.stdout().includes(KEY), false);
  });
});

describe('what serve ignores', () => {
  it('does not read the saved login', async () => {
    // A server runs a server; it does not connect to one. A remote configuration pointing somewhere
    // unusable must make no difference at all.
    const directory = workspace();
    const config = configFile(
      directory,
      `server:\n  host: 127.0.0.1\n  port: 39221\ndatabase:\n  path: ./data/raphael.sqlite\n`,
    );
    const started = startServe(
      ['--config', config],
      {
        RAPHAEL_API_KEY: KEY,
        RAPHAEL_ENDPOINT: 'http://not-a-real-host.invalid',
        XDG_CONFIG_HOME: '/nonexistent/relative',
      },
      directory,
    );

    await waitFor(() => started.stdout().includes('Press Ctrl-C'), 'the server to be ready');
    started.child.kill('SIGINT');
    assert.equal(await started.exited, 0);
  });
});
