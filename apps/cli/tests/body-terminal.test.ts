import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `--body @-` on a terminal says how to finish before it waits, and a pipe gets no instructions.
 *
 * Decided from `isTTY`, so only a real terminal shows it: the command runs under a pseudo-terminal
 * through `support/pty-relay.py`, as the login prompts do. Nothing listens at the endpoint, so once the
 * body is read the command ends as an unreachable server, which proves the read finished.
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(here, '..', 'src', 'main.ts');
const relay = join(here, 'support', 'pty-relay.py');

const HINT = 'Reading the body from standard input. Finish with Ctrl-D, or Ctrl-C to cancel.';
const ENVIRONMENT = {
  PATH: process.env.PATH ?? '',
  TERM: 'dumb',
  RAPHAEL_ENDPOINT: 'http://127.0.0.1:9',
  RAPHAEL_API_KEY: 'zq9x-key-0123456789abcdef0123456789',
};
const ARGV = [main, 'create', 'resource.note', '/work/typed', '--title', 'Typed', '--body', '@-'];

const hasPython =
  spawnSync('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore' }).status === 0;

describe('reading a body from a terminal', { skip: hasPython ? false : 'no python3' }, () => {
  it('says how to finish before it waits, then reads what was typed', async () => {
    const { code, screen } = await new Promise<{ code: number | null; screen: string }>(
      (resolveRun, rejectRun) => {
        const child = spawn('python3', ['-I', relay, process.execPath, ...ARGV], {
          env: ENVIRONMENT,
          timeout: 15_000,
          killSignal: 'SIGKILL',
        });
        let shown = '';
        let typed = false;
        child.stdout.on('data', (chunk: Buffer) => {
          shown += chunk.toString('utf8');
          // Type only once the hint is up: the hint is what tells someone the command is waiting.
          if (!typed && shown.includes(HINT)) {
            typed = true;
            child.stdin.write('# Typed\r\u0004');
          }
        });
        child.on('error', rejectRun);
        child.on('close', (exit) => resolveRun({ code: exit, screen: shown }));
      },
    );
    assert.match(screen, new RegExp(HINT.replaceAll('.', '\\.')));
    // The body was read and the command went on to try the server, which is not there.
    assert.equal(code, 6, screen);
  });

  it('gives a pipe no instructions', () => {
    const ran = spawnSync(process.execPath, ARGV, {
      env: ENVIRONMENT,
      input: '# Piped\n',
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(ran.status, 6, ran.stderr);
    assert.equal(ran.stderr.includes('Reading the body'), false);
  });
});
