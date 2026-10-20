import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiCredential, serve, silentLogger } from '@raphael/backend';
import type { EndpointRejectionReason } from '@raphael/client';
import { PROTOCOL_VERSION } from '@raphael/contracts/connection';
import { Effect, Exit, Scope } from 'effect';

import { invocationOf, toExitCode } from '../src/main.ts';
import { saveConfig } from '../src/modules/connection/config.ts';
import {
  runLogin,
  type LoginDependencies,
  type Prompter,
} from '../src/modules/connection/login.ts';
import { newSession } from '../src/shared/command.ts';
import type { Ran } from './support/cli.ts';
import { caseName, goldenSurface } from './support/golden.ts';

/**
 * `raphael login`, end to end.
 *
 * The scripted cases drive `runLogin` with a `Prompter` that answers from a list, against a live
 * server on an ephemeral port, and pin every outcome's copy. The terminal cases run the real prompt
 * under a pseudo-terminal, because what they prove - that the key is never written back - only
 * exists when there is a terminal to write it to.
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(here, '..', 'src', 'main.ts');
const relay = join(here, 'support', 'pty-relay.py');

/**
 * Long enough to satisfy the shared key policy, and obviously not a real credential. It starts with
 * letters no copy will ever contain, so finding a prefix of it on screen can only mean an echo.
 */
const KEY = 'zq9x-key-0123456789abcdef0123456789';
/** Nothing listens on the discard port, so a connection there is refused straight away. */
const REFUSED = 'http://127.0.0.1:9';

const login = goldenSurface('login');
const directories: string[] = [];
let scope: Scope.CloseableScope;
let endpoint = '';

const temporary = (): string => {
  // Resolved, because /tmp is a symlink on macOS and the configuration checks verify a resolved chain.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-login-')));
  directories.push(directory);
  return directory;
};

before(async () => {
  scope = Effect.runSync(Scope.make());
  const running = await Effect.runPromise(
    Scope.extend(
      serve({
        options: {
          server: { host: '127.0.0.1', port: 0 },
          database: { databasePath: join(temporary(), 'raphael.sqlite') },
        },
        credential: ApiCredential.fromKey(KEY),
        logger: silentLogger,
      }),
      scope,
    ),
  );
  endpoint = `http://127.0.0.1:${running.port}`;
});

after(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(login.strays(), []);
});

/** Answers the address question, then the key question, from what it was given. */
const scripted = (address: string, key: string) => (): Prompter => ({
  ask: async () => address,
  askHidden: async () => key,
  close: () => {},
});

/**
 * Run `login` as the CLI does: a thrown usage or configuration error becomes the output and exit code
 * `toExitCode` gives it. Saved under a fresh XDG_CONFIG_HOME, whose path is then replaced with
 * `<tmp>` so the files do not depend on the machine.
 */
const loginWith = async (
  argv: readonly string[],
  address: string,
  key: string,
  save?: LoginDependencies['save'],
): Promise<Ran> => {
  const root = temporary();
  let stdout = '';
  let stderr = '';
  const streams = {
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
  };
  let code: number;
  const session = newSession(invocationOf(['login', ...argv]));
  try {
    code = await runLogin(argv, {
      streams,
      session,
      prompter: scripted(address, key),
      environment: { XDG_CONFIG_HOME: root },
      platform: process.platform,
      ...(save === undefined ? {} : { save }),
    });
  } catch (error) {
    code = toExitCode(error, streams, session);
  }
  const scrub = (text: string): string =>
    text.replaceAll(root, '<tmp>').replaceAll(endpoint, '<endpoint>');
  return { code, stdout: scrub(stdout), stderr: scrub(stderr) };
};

/** An address for each reason, keyed by the client's own union so a new reason needs a case. */
const BAD_ADDRESSES: Record<EndpointRejectionReason, string> = {
  malformed: 'not an address',
  unsupported_scheme: 'ftp://127.0.0.1',
  credentials_in_url: 'http://me:pw@127.0.0.1',
  query_not_allowed: 'http://127.0.0.1/?a=1',
  fragment_not_allowed: 'http://127.0.0.1/#a',
};

describe('login with a scripted prompt', () => {
  for (const [reason, address] of Object.entries(BAD_ADDRESSES)) {
    it(`refuses an address: ${reason}`, async () => {
      login.expectRun(caseName('address', reason), await loginWith([], address, KEY));
    });
  }

  it('refuses an empty key', async () => {
    login.expectRun('empty-key', await loginWith([], endpoint, ''));
  });

  it('refuses an argument', async () => {
    login.expectRun('argument', await loginWith(['https://example.com'], endpoint, KEY));
  });

  it('refuses a key the server does not accept, saving nothing', async () => {
    login.expectRun('wrong-key', await loginWith([], endpoint, `${KEY}-wrong`));
  });

  it('refuses a server it cannot reach, saving nothing', async () => {
    login.expectRun('unreachable', await loginWith([], REFUSED, KEY));
  });

  it('reports a saved login', async () => {
    login.expectRun('saved', await loginWith([], endpoint, KEY));
  });

  it('reports a saved login as JSON', async () => {
    login.expectRun('saved-json', await loginWith(['--json'], endpoint, KEY));
  });

  // The credential really is saved; only the directory flush could not be confirmed, which a test
  // cannot make a filesystem do, so the save reports it. The login worked: exit 0, and say so.
  const unconfirmed: LoginDependencies['save'] = (location, config) => ({
    ...saveConfig(location, config),
    durabilityUnconfirmed: true,
  });

  it('succeeds with a warning when the save could not be confirmed durable', async () => {
    const ran = await loginWith([], endpoint, KEY, unconfirmed);
    assert.equal(ran.code, 0);
    login.expectRun('saved-durability-unconfirmed', ran);
  });

  it('carries the durability warning in the JSON envelope', async () => {
    const ran = await loginWith(['--json'], endpoint, KEY, unconfirmed);
    assert.equal(ran.code, 0);
    assert.equal(ran.stderr, '', 'with --json, the warning is in the document');
    const document = JSON.parse(ran.stdout) as { warnings: { code: string }[] };
    assert.deepEqual(
      document.warnings.map((warning) => warning.code),
      ['durability_unconfirmed'],
    );
    login.expectRun('saved-durability-unconfirmed-json', ran);
  });
});

describe('login and RAPHAEL_TIMEOUT', () => {
  it('bounds the verification by the timeout it is given', async () => {
    // A server that answers after 1.5 seconds: within the default, beyond RAPHAEL_TIMEOUT=1.
    const slow = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION }));
      }, 1_500);
    });
    await new Promise<void>((resolveListen) => slow.listen(0, '127.0.0.1', resolveListen));
    const address = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      let stderr = '';
      const code = await runLogin([], {
        session: newSession(invocationOf(['login'])),
        streams: {
          out: () => {},
          err: (text) => {
            stderr += text;
          },
        },
        prompter: scripted(address, KEY),
        environment: { XDG_CONFIG_HOME: temporary(), RAPHAEL_TIMEOUT: '1' },
        platform: process.platform,
      });
      assert.equal(code, 6, stderr);
      assert.match(stderr, /did not answer in time\. Nothing was saved\./);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolveClose) => slow.close(() => resolveClose()));
    }
  });
});

/**
 * Run `login` under a pseudo-terminal and answer its prompts as they appear.
 *
 * `support/pty-relay.py` allocates the terminal with Python's standard `pty` module; see that file for
 * why it is not `script`. Each answer is written only after its prompt has appeared, because the
 * address prompt's readline would otherwise read the key's bytes as a second line. Everything the
 * terminal displays, including what the line discipline itself echoes, comes back on stdout.
 */
const underTerminal = (
  answers: ReadonlyArray<readonly [prompt: string, answer: string]>,
): Promise<{ readonly code: number | null; readonly screen: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const root = temporary();
    const child = spawn('python3', ['-I', relay, process.execPath, main, 'login'], {
      // `dumb` on purpose: other terminals follow a prompt with cursor movement, which would stop
      // `endsWith(prompt)` from matching. The fix does not depend on it; it held under xterm by hand.
      env: { PATH: process.env.PATH ?? '', HOME: root, XDG_CONFIG_HOME: root, TERM: 'dumb' },
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    let screen = '';
    const pending = [...answers];
    child.stdout.on('data', (chunk: Buffer) => {
      screen += chunk.toString('utf8');
      const next = pending[0];
      if (next !== undefined && screen.endsWith(next[0])) {
        pending.shift();
        child.stdin.write(next[1]);
      }
    });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, screen }));
  });

/** Python 3 is present on macOS and on common Linux images; without it there is no terminal to test. */
const hasPython =
  spawnSync('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore' }).status === 0;

describe(
  'login at a terminal',
  { skip: hasPython ? false : 'no python3 to allocate a terminal' },
  () => {
    it('never shows the key, on screen or in stdout', async () => {
      const ran = await underTerminal([
        ['Server address: ', `${REFUSED}\r`],
        ['API key: ', `${KEY}\r`],
      ]);
      // The prompt was answered and the login went on to try the connection, so the key was read.
      assert.match(ran.screen, /API key: /);
      assert.match(ran.screen, /Could not connect to the server at \S+\. Nothing was saved\./);
      assert.equal(ran.code, 6, 'nothing was sent, and trying again may work');
      assert.equal(ran.screen.includes(KEY), false, `the key appeared on screen:\n${ran.screen}`);
      // Not even a prefix of it: one echoed keypress is already a leak.
      assert.equal(ran.screen.includes(KEY.slice(0, 4)), false);
    });

    it('cancels on Ctrl-C at the address prompt', async () => {
      const ran = await underTerminal([['Server address: ', 'http\u0003']]);
      assert.match(ran.screen, /Cancelled\. Nothing was saved\./);
      assert.equal(ran.code, 2);
    });

    it('cancels on Ctrl-D at an empty address prompt', async () => {
      const ran = await underTerminal([['Server address: ', '\u0004']]);
      assert.match(ran.screen, /Cancelled\. Nothing was saved\./);
      assert.equal(ran.code, 2);
    });

    it('cancels on Ctrl-C at the key prompt', async () => {
      const ran = await underTerminal([
        ['Server address: ', `${REFUSED}\r`],
        ['API key: ', 'abc\u0003'],
      ]);
      assert.match(ran.screen, /Cancelled\. Nothing was saved\./);
      assert.equal(ran.screen.includes('abc'), false);
      assert.equal(ran.code, 2);
    });
  },
);
