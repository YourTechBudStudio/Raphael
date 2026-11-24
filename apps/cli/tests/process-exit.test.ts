import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The process ends when the command does.
 *
 * Both cases need a real process: one is about what keeps Node's event loop alive after the outcome
 * is printed, the other about what the operating system does with a write to a file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = join(resolve(here, '..'), 'src', 'main.ts');
const directories: string[] = [];

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const workspace = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-exit-')));
  directories.push(directory);
  return directory;
};

describe('a connection attempt that never completes', () => {
  it('does not hold the process past the timeout it reported', async () => {
    const home = workspace();
    for (const argv of [['status'], ['list', '/'], ['create', 'area', '/q', '--title', 'Q']]) {
      const startedAt = Date.now();
      const child = spawn(
        process.execPath,
        ['--import', join(here, 'support', 'pending-connect.ts'), main, ...argv],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            RAPHAEL_ENDPOINT: 'http://127.0.0.1:2',
            RAPHAEL_API_KEY: 'test-key-0123456789abcdef0123456789',
            RAPHAEL_TIMEOUT: '1',
          },
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const code = await new Promise<number | null>((resolveExit) =>
        child.on('close', (exitCode) => resolveExit(exitCode)),
      );
      const elapsed = Date.now() - startedAt;
      assert.match(stderr, /did not answer in time/u, argv.join(' '));
      assert.equal(code, argv[0] === 'create' ? 7 : 6, argv.join(' '));
      // One second of timeout plus startup, with a wide margin; the pending attempt lives a minute.
      assert.ok(elapsed < 15_000, `${argv.join(' ')} exited after ${elapsed} ms`);
    }
  });
});

describe('results that cannot all be written', () => {
  it('says so on stderr when a single write to a file comes up short', () => {
    const directory = workspace();
    // A file size limit stands in for a full disk: the one write of the reference is cut at 1 KiB,
    // which the system reports as a short write and not as an error. SIGXFSZ is ignored, as a
    // shell running under a limit would, so the write fails instead of killing the process.
    const ran = spawnSync(
      '/bin/sh',
      [
        '-c',
        `trap "" XFSZ; ulimit -f 1; exec "$0" "$1" help reference > out.txt`,
        process.execPath,
        main,
      ],
      { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    );
    assert.equal(ran.stderr, 'Could not write the output (EFBIG).\n');
    // The exit code describes the command, which succeeded (phase 02).
    assert.equal(ran.status, 0);
    assert.ok(readFileSync(join(directory, 'out.txt')).length < 44_000);
  });
});
