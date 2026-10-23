import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
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

import { version } from '../src/distribution.ts';
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
        release: version(),
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
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly prompter?: () => Prompter;
    readonly stdin?: LoginDependencies['stdin'];
    readonly root?: string;
  } = {},
): Promise<Ran> => {
  const root = options.root ?? temporary();
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
      prompter: options.prompter ?? scripted(address, key),
      environment: { XDG_CONFIG_HOME: root, ...options.environment },
      platform: process.platform,
      ...(save === undefined ? {} : { save }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
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

  it('refuses more than one argument', async () => {
    login.expectRun(
      'two-arguments',
      await loginWith(['https://example.com', 'extra'], endpoint, KEY),
    );
  });

  it('never prints a password or token from a rejected address, as text or JSON', async () => {
    const secret = 'example-secret';
    for (const address of [
      `http://user:${secret}@localhost:3000`,
      `user:${secret}@localhost:3000`,
      `ftp://me:${secret}@127.0.0.1`,
      `http://127.0.0.1:3000/?token=${secret}`,
      `http://127.0.0.1:3000/#${secret}`,
      `localhost:3000/x?token=${secret}`,
      `//user:${secret}@localhost:3000`,
      `http:////user:${secret}@localhost:3000`,
      `http:/user:${secret}@localhost:3000`,
      `localhost:3000/@user:${secret}`,
      `user@${secret}:3000`,
    ]) {
      for (const argv of [[], ['--json']]) {
        const prompted = await loginWith(argv, address, KEY);
        const argument = await loginWith([address, ...argv], 'unused', KEY);
        for (const ran of [prompted, argument]) {
          assert.equal(ran.code, 2, address);
          assert.equal(
            `${ran.stdout}${ran.stderr}`.includes(secret),
            false,
            `${address}: ${ran.stderr}`,
          );
        }
      }
    }
  });

  it('refuses a bare host and port with the fix spelled out', async () => {
    login.expectRun('address-bare-host-and-port', await loginWith([], 'localhost:3105', KEY));
  });

  it('refuses a typed key no header can carry, without showing it', async () => {
    const ran = await loginWith([], endpoint, `${KEY} with spaces`);
    assert.equal(ran.code, 2);
    assert.equal(ran.stderr.includes(KEY), false);
    login.expectRun('unsendable-key', ran);
  });

  it('takes the address as an argument and asks only for the key', async () => {
    const asked: string[] = [];
    const ran = await loginWith([endpoint], 'unused', KEY, undefined, {
      prompter: () => ({
        ask: async (question) => {
          asked.push(question);
          throw new Error('the address was given; it must not be asked for');
        },
        askHidden: async (question) => {
          asked.push(question);
          return KEY;
        },
        close: () => {},
      }),
    });
    assert.deepEqual(asked, ['API key: ']);
    login.expectRun('address-argument', ran);
  });

  it('refuses a configuration directory it could not keep a key in, before asking for one', async () => {
    const root = temporary();
    mkdirSync(join(root, 'raphael'), { mode: 0o700 });
    chmodSync(join(root, 'raphael'), 0o755);
    const ran = await loginWith([], endpoint, KEY, undefined, {
      root,
      prompter: () => {
        throw new Error('no prompt may appear before the destination is checked');
      },
    });
    assert.equal(ran.code, 5);
    login.expectRun('directory-checked-before-prompt', ran);
  });

  it('warns when the environment pair will override what it saved', async () => {
    const ran = await loginWith([], endpoint, KEY, undefined, {
      environment: { RAPHAEL_ENDPOINT: 'http://127.0.0.1:9', RAPHAEL_API_KEY: 'other-key' },
    });
    assert.equal(ran.code, 0);
    login.expectRun('saved-environment-overrides', ran);
    const json = await loginWith(['--json'], endpoint, KEY, undefined, {
      environment: { RAPHAEL_API_KEY: 'other-key' },
    });
    const document = JSON.parse(json.stdout) as { warnings: { code: string }[] };
    assert.deepEqual(
      document.warnings.map((warning) => warning.code),
      ['environment_overrides'],
    );
  });

  it('says when it replaced a saved login for a different server', async () => {
    const root = temporary();
    saveConfig(
      { directory: join(root, 'raphael'), file: join(root, 'raphael', 'config.json') },
      {
        endpoint: 'http://old.example.com',
        apiKey: KEY,
      },
    );
    const ran = await loginWith([], endpoint, KEY, undefined, { root });
    assert.equal(ran.code, 0);
    login.expectRun('saved-replaced', ran);
    // The same server again is not a replacement worth mentioning.
    const again = await loginWith(['--json'], endpoint, KEY, undefined, { root });
    assert.equal((JSON.parse(again.stdout) as { replaced: unknown }).replaced, null);
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

/** Standard input that is a pipe holding these bytes. */
const piped = (text: string | Buffer): LoginDependencies['stdin'] => ({
  isTTY: false,
  read: async () => (typeof text === 'string' ? Buffer.from(text, 'utf8') : text),
});

describe('login --api-key-stdin', () => {
  it('reads the key from a pipe, with one trailing newline removed', async () => {
    for (const [label, input] of [
      ['newline', `${KEY}\n`],
      ['crlf', `${KEY}\r\n`],
      ['no-newline', KEY],
    ] as const) {
      const root = temporary();
      const ran = await loginWith(
        [endpoint, '--api-key-stdin', '--json'],
        'unused',
        'unused',
        undefined,
        {
          root,
          stdin: piped(input),
          prompter: () => {
            throw new Error('no prompt when the key is piped');
          },
        },
      );
      assert.equal(ran.code, 0, `${label}: ${ran.stderr}`);
      const saved = JSON.parse(readFileSync(join(root, 'raphael', 'config.json'), 'utf8')) as {
        apiKey: string;
      };
      assert.equal(saved.apiKey, KEY, label);
    }
  });

  it('refuses an empty pipe, more than one line, or anything after the line, saving nothing', async () => {
    for (const [label, input] of [
      ['empty', ''],
      ['only-newline', '\n'],
      ['two-lines', `${KEY}\nsecond\n`],
      ['two-newlines', `${KEY}\n\n`],
      ['trailing-space', `${KEY} \n`],
      ['not-ascii', `${KEY}é\n`],
    ] as const) {
      const root = temporary();
      const ran = await loginWith([endpoint, '--api-key-stdin'], 'unused', 'unused', undefined, {
        root,
        stdin: piped(input),
      });
      assert.equal(ran.code, 2, label);
      assert.equal(ran.stderr.includes(KEY), false, `${label}: the key was echoed`);
      assert.equal(existsSync(join(root, 'raphael', 'config.json')), false, label);
      if (label === 'empty' || label === 'two-lines') {
        login.expectRun(caseName('stdin', label), ran);
      }
    }
  });

  it('needs the address as an argument, and refuses a terminal on standard input', async () => {
    login.expectRun(
      'stdin-without-address',
      await loginWith(['--api-key-stdin'], endpoint, KEY, undefined, { stdin: piped(KEY) }),
    );
    login.expectRun(
      'stdin-is-terminal',
      await loginWith([endpoint, '--api-key-stdin'], endpoint, KEY, undefined, {
        stdin: { isTTY: true, read: async () => Buffer.from(KEY) },
      }),
    );
  });

  it('bounds what it reads from standard input', async () => {
    const { Readable } = await import('node:stream');
    const { readStandardInput } = await import('../src/shared/stdin.ts');
    const huge = Readable.from([Buffer.alloc(64 * 1024 + 1, 0x61)]);
    await assert.rejects(
      readStandardInput({ limit: 64 * 1024, tooLarge: () => new Error('too large'), input: huge }),
      /too large/,
    );
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
  options: {
    readonly command?: readonly string[];
    readonly root?: string;
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ readonly code: number | null; readonly screen: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const root = options.root ?? temporary();
    const command = options.command ?? [process.execPath, main, 'login'];
    const child = spawn('python3', ['-I', relay, ...command], {
      // `dumb` on purpose: other terminals follow a prompt with cursor movement, which would stop
      // `endsWith(prompt)` from matching. The fix does not depend on it; it held under xterm by hand.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        XDG_CONFIG_HOME: root,
        TERM: 'dumb',
        ...options.environment,
      },
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
      assert.doesNotMatch(ran.screen, /--help|unsettled/, 'a cancellation is not a usage mistake');
      assert.equal(ran.code, 2);
    });

    it('cancels on Ctrl-D at an empty address prompt', async () => {
      const ran = await underTerminal([['Server address: ', '\u0004']]);
      assert.match(ran.screen, /Cancelled\. Nothing was saved\./);
      assert.doesNotMatch(ran.screen, /--help|unsettled/);
      assert.equal(ran.code, 2);
    });

    it('cancels on Ctrl-D at an empty key prompt', async () => {
      const ran = await underTerminal([
        ['Server address: ', `${REFUSED}\r`],
        ['API key: ', '\u0004'],
      ]);
      assert.match(ran.screen, /No key was entered\. Nothing was saved\./);
      assert.doesNotMatch(ran.screen, /--help/);
      assert.equal(ran.code, 2);
    });

    it('prompts on standard error, so standard output holds only the result', async () => {
      const root = temporary();
      const out = join(root, 'result.json');
      const ran = await underTerminal(
        [
          ['Server address: ', `${endpoint}\r`],
          ['API key: ', `${KEY}\r`],
        ],
        {
          // stdout goes to a file; anything the terminal shows came through stderr.
          command: [
            '/bin/sh',
            '-c',
            `exec "$0" "$1" login --json > "$2"`,
            process.execPath,
            main,
            out,
          ],
          root,
        },
      );
      assert.equal(ran.code, 0, ran.screen);
      assert.match(ran.screen, /Server address: /);
      assert.match(ran.screen, /API key: /);
      assert.equal(ran.screen.includes(KEY.slice(0, 4)), false);
      const document = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; endpoint: string };
      assert.equal(document.ok, true);
      assert.equal(document.endpoint, endpoint);
    });

    it('shows the override warning at the terminal', async () => {
      const ran = await underTerminal(
        [
          ['Server address: ', `${endpoint}\r`],
          ['API key: ', `${KEY}\r`],
        ],
        { environment: { RAPHAEL_ENDPOINT: REFUSED, RAPHAEL_API_KEY: 'other-key' } },
      );
      assert.equal(ran.code, 0, ran.screen);
      assert.match(
        ran.screen,
        /warning: RAPHAEL_ENDPOINT and RAPHAEL_API_KEY are set in this environment/,
      );
    });

    it('refuses a bad address before asking for the key', async () => {
      const ran = await underTerminal([['Server address: ', 'localhost:3000\r']]);
      assert.match(ran.screen, /"localhost:3000" is not a usable address: it has no scheme/);
      assert.doesNotMatch(ran.screen, /API key: /, 'no key is asked for after a bad address');
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
