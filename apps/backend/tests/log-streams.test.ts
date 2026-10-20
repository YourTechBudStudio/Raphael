import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The console logger never takes the server down.
 *
 * Every line goes to stderr, and a reader that went away - `serve 2>&1 | head -1` - is not an error:
 * the lines nobody can receive are dropped. Run in its own process, because what is tested is how
 * the process's real stderr behaves once its pipe is closed.
 */

const log = pathToFileURL(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src/infrastructure/http/log.ts'),
).href;

/** Logs once, waits for the parent to close the pipe, then logs many more lines and exits 0. */
const SCRIPT = `
const { consoleLogger } = await import(${JSON.stringify(log)});
consoleLogger.log('info', 'server.listening', { port: 1 });
process.stdin.once('data', async () => {
  for (let i = 0; i < 2000; i += 1) {
    consoleLogger.log('info', 'server.stopping', { i });
    await new Promise((r) => setImmediate(r));
  }
  process.exit(0);
});
`;

describe('the console logger', () => {
  test('writes every level to stderr, and nothing to stdout', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      child.stdin.end('go');
    });
    const code = await new Promise<number | null>((done) => child.on('close', done));
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /^\[raphael\] info server\.listening port=1$/m);
  });

  test('drops lines once stderr is gone, instead of crashing', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT]);
    child.stderr.once('data', () => {
      child.stderr.destroy();
      child.stdin.end('go');
    });
    const code = await new Promise<number | null>((done) => child.on('close', done));
    assert.equal(code, 0, 'a log line nobody can receive must not stop the process');
  });
});
