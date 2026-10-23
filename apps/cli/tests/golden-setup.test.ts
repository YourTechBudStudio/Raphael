import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { PROTOCOL_VERSION } from '@raphael/contracts/connection';

import { version } from '../src/distribution.ts';
import { saveConfig } from '../src/modules/connection/config.ts';
import { connectFrom } from '../src/modules/connection/remote.ts';
import {
  STUB_KEY,
  errorResponse,
  runCli,
  stubServer,
  type Ran,
  type StubRequest,
} from './support/cli.ts';
import { assertErrorDocument, goldenSurface } from './support/golden.ts';

/**
 * The setup commands an agent runs before anything else: `status`, `logout` and `version`.
 *
 * `status` is pinned against a stub that answers verification the way each kind of server would, so
 * every outcome - accepted, skewed, rejected, mismatched, not Raphael, unreachable, not configured -
 * reads as it will. `logout` runs against a real temporary configuration directory.
 */

const setup = goldenSurface('setup');
const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(setup.strays(), []);
});

const temporary = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-setup-')));
  directories.push(directory);
  return directory;
};

/** This release as a whole word, so it is not found inside an address such as 127.0.0.1. */
const RELEASE = new RegExp(`(?<![\\d.])${version().replaceAll('.', '\\.')}(?![\\d.])`, 'gu');

const scrub = (ran: Ran, root: string): Ran => {
  const clean = (text: string): string =>
    (root === '' ? text : text.replaceAll(root, '<tmp>')).replace(RELEASE, '<version>');
  return { code: ran.code, stdout: clean(ran.stdout), stderr: clean(ran.stderr) };
};

const verifying = (respond: (request: StubRequest) => Response) =>
  stubServer(respond, undefined, { answerVerify: false });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Run `status` as text and as JSON against one stub, and pin both. */
const pinStatus = async (
  name: string,
  respond: (request: StubRequest) => Response,
): Promise<Ran> => {
  const server = verifying(respond);
  const text = scrub(await runCli(['status'], { connect: server.connect }), '');
  const asJson = scrub(await runCli(['status', '--json'], { connect: server.connect }), '');
  assert.equal(text.code, asJson.code);
  // One verification per run, and nothing else.
  assert.equal(server.requests.length, 2);
  setup.expectRun(`status-${name}`, text);
  setup.expectRun(`status-${name}-json`, asJson);
  return asJson;
};

describe('status', () => {
  it('reports a usable connection', async () => {
    const ran = await pinStatus('ok', () =>
      json({ protocolVersion: PROTOCOL_VERSION, raphaelVersion: version() }),
    );
    assert.equal(ran.code, 0);
    const document = JSON.parse(ran.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document), [
      'ok',
      'command',
      'connection',
      'protocolVersion',
      'serverVersion',
      'cliVersion',
    ]);
  });

  it('warns about a release difference that the protocol allows', async () => {
    const ran = await pinStatus('version-skew', () =>
      json({ protocolVersion: PROTOCOL_VERSION, raphaelVersion: '9.9.9' }),
    );
    assert.equal(ran.code, 0);
  });

  it('says it does not know the release of a server that does not report one', async () => {
    const ran = await pinStatus('release-unknown', () =>
      json({ protocolVersion: PROTOCOL_VERSION }),
    );
    assert.equal((JSON.parse(ran.stdout) as { serverVersion: unknown }).serverVersion, null);
  });

  it('refuses a rejected key, naming where it came from', async () => {
    const ran = await pinStatus('unauthorized', () =>
      errorResponse(401, 'unauthorized', 'A valid API key is required.'),
    );
    assertErrorDocument(ran, { exit: 5, code: 'unauthorized', command: 'status' });
  });

  it('refuses a server that speaks another protocol', async () => {
    const ran = await pinStatus('incompatible', () =>
      json({ protocolVersion: '2099-01-01', raphaelVersion: '9.0.0' }),
    );
    assertErrorDocument(ran, { exit: 5, code: 'incompatible_protocol', command: 'status' });
  });

  it('refuses an endpoint that is not a Raphael server', async () => {
    const ran = await pinStatus(
      'not-raphael',
      () =>
        new Response('<html>Not Found</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    );
    assertErrorDocument(ran, { exit: 5, code: 'not_raphael', command: 'status' });
  });

  it('reports a server it cannot reach as retryable', async () => {
    const ran = await pinStatus('unreachable', () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      });
    });
    assertErrorDocument(ran, { exit: 6, code: 'unreachable', command: 'status' });
  });

  it('reports no connection at all, naming the file it looked for', async () => {
    const root = temporary();
    const environment = { XDG_CONFIG_HOME: root };
    const run = (argv: readonly string[]): Promise<Ran> =>
      runCli(argv, { environment, connect: () => connectFrom(environment, process.platform) });
    const text = scrub(await run(['status']), root);
    const asJson = scrub(await run(['status', '--json']), root);
    setup.expectRun('status-not-configured', text);
    setup.expectRun('status-not-configured-json', asJson);
    const document = assertErrorDocument(asJson, { exit: 5, code: 'not_configured' });
    assert.equal('connection' in document.error, false, 'no connection was resolved');
  });

  it('reports the environment pair as the source when it is set', async () => {
    const environment = { RAPHAEL_ENDPOINT: 'http://127.0.0.1:9', RAPHAEL_API_KEY: STUB_KEY };
    const ran = await runCli(['status', '--json'], {
      environment,
      connect: () => connectFrom(environment, process.platform),
    });
    const document = assertErrorDocument(ran, { exit: 6 });
    assert.deepEqual(document.error.connection, {
      endpoint: 'http://127.0.0.1:9',
      source: 'environment',
      configFile: null,
    });
  });
});

/** Run `logout` with a fresh XDG_CONFIG_HOME prepared by `prepare`. */
const logoutWith = async (
  argv: readonly string[],
  prepare: (root: string) => void,
  extra: Readonly<Record<string, string>> = {},
): Promise<{ readonly ran: Ran; readonly root: string }> => {
  const root = temporary();
  prepare(root);
  const ran = await runCli(['logout', ...argv], {
    environment: { XDG_CONFIG_HOME: root, ...extra },
  });
  return { ran: scrub(ran, root), root };
};

const location = (root: string) => ({
  directory: join(root, 'raphael'),
  file: join(root, 'raphael', 'config.json'),
});

describe('logout', () => {
  it('removes the saved login and names the server it was for', async () => {
    for (const argv of [[], ['--json']]) {
      const { ran, root } = await logoutWith(argv, (dir) =>
        saveConfig(location(dir), { endpoint: 'http://127.0.0.1:3000', apiKey: STUB_KEY }),
      );
      assert.equal(ran.code, 0);
      setup.expectRun(`logout-removed${argv.length === 0 ? '' : '-json'}`, ran);
      assert.equal(existsSync(location(root).file), false, 'the file is gone');
    }
  });

  it('says there is nothing to remove, and succeeds', async () => {
    const { ran } = await logoutWith([], () => {});
    assert.equal(ran.code, 0);
    setup.expectRun('logout-nothing', ran);
  });

  it('warns that the environment pair is still set and still used', async () => {
    const { ran } = await logoutWith(
      [],
      (dir) => saveConfig(location(dir), { endpoint: 'http://127.0.0.1:3000', apiKey: STUB_KEY }),
      { RAPHAEL_ENDPOINT: 'http://127.0.0.1:9', RAPHAEL_API_KEY: STUB_KEY },
    );
    setup.expectRun('logout-environment-still-set', ran);
  });

  it('removes a link without following it', async () => {
    let target = '';
    const { ran } = await logoutWith([], (dir) => {
      mkdirSync(join(dir, 'raphael'), { mode: 0o700 });
      target = join(dir, 'kept.json');
      writeFileSync(target, JSON.stringify({ endpoint: 'http://x', apiKey: STUB_KEY }), {
        mode: 0o600,
      });
      symlinkSync(target, location(dir).file);
    });
    assert.equal(ran.code, 0);
    assert.equal(existsSync(target), true, 'the link target is untouched');
    setup.expectRun('logout-link', ran);
  });

  it('applies the directory checks before removing anything', async () => {
    const { ran, root } = await logoutWith([], (dir) => {
      saveConfig(location(dir), { endpoint: 'http://127.0.0.1:3000', apiKey: STUB_KEY });
      chmodSync(join(dir, 'raphael'), 0o755);
    });
    assert.equal(ran.code, 5);
    assert.equal(existsSync(location(root).file), true, 'nothing was removed');
    setup.expectRun('logout-directory-unusable', ran);
  });
});

describe('version', () => {
  it('prints the bare release, and the protocol too with --json, offline', async () => {
    const text = await runCli(['version']);
    assert.equal(text.code, 0);
    assert.equal(text.stdout, `${version()}\n`);
    assert.equal(text.stderr, '');
    const asJson = await runCli(['version', '--json']);
    assert.deepEqual(JSON.parse(asJson.stdout), {
      ok: true,
      command: 'version',
      version: version(),
      protocolVersion: PROTOCOL_VERSION,
    });
    assert.deepEqual(
      JSON.parse((await runCli(['--version', '--json'])).stdout),
      JSON.parse(asJson.stdout),
    );
  });
});
