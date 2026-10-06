/**
 * Behavioural verification of one release tarball, installed the way a person installs it.
 *
 * Everything here is about the artifact, not the checkout: the tarball is installed by npm, offline,
 * from a fresh cache, with lifecycle scripts off and an unreachable registry, into a directory outside
 * any repository, and the npm-created `raphael` link is what runs. Nothing from the workspace is on
 * the resolution path, so a dependency the bundle forgot is a failure here rather than something the
 * checkout quietly supplies.
 *
 * What is established, in order:
 *
 * - npm installs exactly one package, and `npm exec` runs it offline too;
 * - help and version, with the expected version;
 * - a server from the installation starts against a configuration-relative database, accepts the right
 *   key, refuses a wrong or missing one, round-trips create, get, and full-text search, and stops
 *   cleanly on SIGTERM;
 * - in copies of the installation with the native driver removed or corrupted, help, version, and a
 *   remote operation against the intact server still work, while `server serve` fails with context;
 * - in a copy without its migration journal, `server serve` fails naming it;
 * - restarted on the same database, the records are still there and the seed areas are not repeated.
 *
 * It imports only Node built-ins and its own siblings that do the same, so `apps/cli/packaging` can be
 * copied to another machine and run there against the same tarball:
 *
 *   node verify.ts <tarball> [--expect-version <version>]
 *
 * It verifies the platform it runs on, and the record it returns says which. A prebuild being present
 * for another platform establishes nothing about whether it loads there.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { integrityOf, readArchiveFile } from './archive.ts';
import { PackagingError } from './errors.ts';
import { BIN_NAME, checkReleaseManifest, type ReleaseManifest } from './manifest.ts';

/**
 * The behavioural contract above, as a number. A release receipt names the contract that passed;
 * anything that weakens or changes what is checked bumps it, so an older receipt stops authorizing.
 */
export const VERIFIER_CONTRACT = 1;

export interface VerificationRecord {
  readonly contract: number;
  /** npm's integrity string of the tarball that was verified. */
  readonly integrity: string;
  readonly platform: string;
  readonly arch: string;
  /** `glibc` or `musl` on Linux; absent elsewhere. */
  readonly libc?: 'glibc' | 'musl';
  readonly node: string;
}

export interface VerifyOptions {
  /** The version the caller expects, when it knows one. The repository always does. */
  readonly version?: string;
  /** The Node requirement the caller expects in the packaged manifest. */
  readonly engines?: string;
  readonly log?: (line: string) => void;
  /**
   * Interrupts verification. Every process it started is stopped (gracefully, then forcibly after a
   * bounded wait), no further probe runs, and its temporary directory is removed before it rejects.
   */
  readonly signal?: AbortSignal;
}

/** The message a verification stopped by its `signal` rejects with. */
export const INTERRUPTED = 'verification was interrupted.';

/** A key long enough for the shared key policy, and plainly not a real credential. */
const KEY = 'verify-key-0123456789abcdef0123456789';
const WRONG_KEY = 'w'.repeat(40);

const STEP_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Seeded by the first migration into every fresh database. */
const SEED_AREAS = ['personal', 'work'];

const libc = (): 'glibc' | 'musl' | undefined => {
  if (process.platform !== 'linux') return undefined;
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
    .header;
  return header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc';
};

/** The prebuild this host's loader selects, by the same rule as the vendored loader. */
const hostPrebuild = (): string =>
  `${libc() === 'musl' ? 'linuxmusl' : process.platform}-${process.arch}.node`;

/** Only what a process needs to find executables and a temporary directory; no resolution overrides. */
const baseEnvironment = (home: string): Record<string, string> => {
  const kept: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  for (const name of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) {
    const value = process.env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
};

export interface Ran {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const describeRun = (label: string, ran: Ran): string =>
  `${label} exited ${String(ran.code ?? ran.signal)}.\n--- stdout\n${ran.stdout}\n--- stderr\n${ran.stderr}`;

const expectSuccess = async (label: string, running: Ran | Promise<Ran>): Promise<Ran> => {
  const ran = await running;
  if (ran.code !== 0) throw new PackagingError(describeRun(label, ran));
  return ran;
};

const expect = (condition: boolean, message: string): void => {
  if (!condition) throw new PackagingError(message);
};

/** A port that was free a moment ago. A configuration file may not ask for port 0, by design. */
const freePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolvePort(address.port);
        else rejectPort(new PackagingError('could not discover a free port.'));
      });
    });
  });

export interface Stopped {
  readonly ran: Ran;
  /** Whether it had to be killed because it outlived the shutdown window. */
  readonly forced: boolean;
}

export interface Server {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<Ran>;
}

/**
 * Every process this verification starts, finite steps and servers alike, so that each one is stopped
 * whatever happens: a failure, a timeout, or an interruption.
 */
export class Processes {
  readonly #running = new Set<Server>();
  /** One shutdown per process, shared by everyone who asks for it, so SIGTERM is sent only once. */
  readonly #stopping = new Map<Server, Promise<Stopped>>();
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = (): void => void this.stopAll();

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
    signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  /** Throws once interrupted, so that no further probe starts. */
  checkpoint(): void {
    if (this.#signal?.aborted === true) throw new PackagingError(INTERRUPTED);
  }

  start(bin: string, args: readonly string[], cwd: string, env: Record<string, string>): Server {
    this.checkpoint();
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<Ran>((resolveExit) => {
      child.once('error', (error) => {
        // A process that could not be started never closes; one that failed later still will.
        if (child.pid === undefined) {
          resolveExit({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` });
        }
      });
      child.once('close', (code, signal) => resolveExit({ code, signal, stdout, stderr }));
    });
    const server: Server = { child, stdout: () => stdout, stderr: () => stderr, exited };
    this.#running.add(server);
    void exited.then(() => this.#running.delete(server));
    return server;
  }

  /** Runs a command that should finish, killing it if it outlives its time limit. */
  async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string> },
  ): Promise<Ran> {
    const started = this.start(command, args, options.cwd, options.env);
    let ran = await within(started.exited, STEP_TIMEOUT_MS);
    if (ran === undefined) {
      // A step that hung. If it is already being stopped, that shutdown keeps its grace period.
      if (!this.#stopping.has(started)) started.child.kill('SIGKILL');
      ran = await started.exited;
    }
    this.checkpoint();
    return ran;
  }

  /**
   * Stops one process: SIGTERM once, then SIGKILL only if it is still running when the shutdown
   * window ends. Asking again, from anywhere, joins the shutdown already under way rather than
   * signalling again - Raphael's server, like many, treats a second signal as "stop immediately".
   */
  stop(server: Server): Promise<Stopped> {
    const existing = this.#stopping.get(server);
    if (existing !== undefined) return existing;
    const stopping = (async (): Promise<Stopped> => {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGTERM');
      }
      const ran = await within(server.exited, SHUTDOWN_TIMEOUT_MS);
      if (ran !== undefined) return { ran, forced: false };
      server.child.kill('SIGKILL');
      return { ran: await server.exited, forced: true };
    })();
    this.#stopping.set(server, stopping);
    return stopping;
  }

  /** Stops every process still running, each through its one shared shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#running].map((server) => this.stop(server)));
  }

  /** Stops everything still running and stops listening for interruption. */
  async close(): Promise<void> {
    this.#signal?.removeEventListener('abort', this.#onAbort);
    await this.stopAll();
  }
}

const within = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Resolves when the server says it is ready; fails if it exits or does not get there in time. */
const ready = async (processes: Processes, server: Server, label: string): Promise<void> => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let exited: Ran | undefined;
  void server.exited.then((ran) => (exited = ran));
  while (!/Press Ctrl-C to stop\./.test(server.stdout())) {
    processes.checkpoint();
    if (exited !== undefined) throw new PackagingError(describeRun(label, exited));
    if (Date.now() > deadline) {
      throw new PackagingError(
        `${label} was not ready within ${String(STARTUP_TIMEOUT_MS)}ms.\n--- stderr\n${server.stderr()}`,
      );
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
};

/** Waits for a server that is expected to refuse to start. */
const refusesToStart = async (
  processes: Processes,
  server: Server,
  label: string,
): Promise<Ran> => {
  const ran = await within(server.exited, STARTUP_TIMEOUT_MS);
  processes.checkpoint();
  if (ran === undefined) {
    throw new PackagingError(`${label} kept running when it should have refused to start.`);
  }
  expect(ran.code !== 0 && ran.code !== null, describeRun(`${label} (expected a failure)`, ran));
  expect(/The server could not start\./.test(ran.stderr), describeRun(label, ran));
  return ran;
};

const serverConfig = (directory: string, port: number): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'raphael.yaml');
  // A relative database path, which must resolve against this file's directory, not the cwd.
  writeFileSync(
    path,
    `server:\n  host: 127.0.0.1\n  port: ${String(port)}\ndatabase:\n  path: ./data/raphael.sqlite\n`,
  );
  return path;
};

const verifyInstalled = async (
  manifest: ReleaseManifest,
  tarball: string,
  scratch: string,
  log: (line: string) => void,
  processes: Processes,
): Promise<void> => {
  const home = join(scratch, 'home dir');
  const npmConfig = join(scratch, 'empty user npmrc');
  const npmGlobalConfig = join(scratch, 'empty global npmrc');
  const install = join(scratch, 'install root');
  const elsewhere = join(scratch, 'unrelated cwd');
  for (const directory of [home, install, elsewhere]) mkdirSync(directory, { recursive: true });
  writeFileSync(npmConfig, '');
  writeFileSync(npmGlobalConfig, '');
  writeFileSync(
    join(install, 'package.json'),
    JSON.stringify({ name: 'raphael-artifact-check', private: true }),
  );

  const npmEnvironment = (cache: string): Record<string, string> => ({
    ...baseEnvironment(home),
    npm_config_userconfig: npmConfig,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_cache: cache,
    // Unreachable, so a request for anything that is not in the tarball fails rather than succeeding.
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  });

  log('installing the tarball offline with a fresh cache');
  await expectSuccess(
    'npm install',
    await processes.run('npm', ['install', tarball], {
      cwd: install,
      env: npmEnvironment(join(scratch, 'npm cache')),
    }),
  );
  const lock = JSON.parse(readFileSync(join(install, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, unknown>;
  };
  const installedPackages = Object.keys(lock.packages ?? {}).filter((key) => key !== '');
  expect(
    JSON.stringify(installedPackages) === JSON.stringify([`node_modules/${manifest.name}`]),
    `npm installed more than the artifact: ${installedPackages.join(', ')}`,
  );
  const topLevel = readdirSync(join(install, 'node_modules')).filter(
    (entry) => entry !== '.bin' && entry !== '.package-lock.json',
  );
  const [scope] = manifest.name.split('/');
  expect(
    JSON.stringify(topLevel) === JSON.stringify([scope]) &&
      JSON.stringify(readdirSync(join(install, 'node_modules', scope as string))) ===
        JSON.stringify([manifest.name.split('/')[1]]),
    `node_modules holds more than the artifact: ${topLevel.join(', ')}`,
  );

  const bin = (root: string): string => join(root, 'node_modules', '.bin', BIN_NAME);
  const environment = baseEnvironment(home);
  const cli = (
    root: string,
    args: readonly string[],
    extra: Record<string, string> = {},
  ): Promise<Ran> =>
    processes.run(bin(root), args, { cwd: elsewhere, env: { ...environment, ...extra } });

  log('running help and version through the npm-created link');
  expect(
    /Usage: raphael/.test((await expectSuccess('raphael --help', cli(install, ['--help']))).stdout),
    'raphael --help did not print usage.',
  );
  const reported = (
    await expectSuccess('raphael --version', cli(install, ['--version']))
  ).stdout.trim();
  expect(
    reported === manifest.version,
    `raphael --version reported "${reported}", not "${manifest.version}".`,
  );

  log('running the package through npm exec, offline');
  const executed = await expectSuccess(
    'npm exec',
    await processes.run(
      'npm',
      ['exec', '--yes', `--package=${tarball}`, '--', BIN_NAME, '--version'],
      {
        cwd: elsewhere,
        env: npmEnvironment(join(scratch, 'npx cache')),
      },
    ),
  );
  expect(
    executed.stdout.trim() === manifest.version,
    `npm exec reported "${executed.stdout.trim()}", not "${manifest.version}".`,
  );

  // Copies with one thing missing, made before the server ever runs so they share no state with it.
  // Symbolic links are copied as they are, so each copy's `.bin` link points into that copy.
  const copy = (name: string): string => {
    const target = join(scratch, name);
    cpSync(install, target, { recursive: true, verbatimSymlinks: true });
    return target;
  };
  const packaged = (root: string, ...path: string[]): string =>
    join(root, 'node_modules', manifest.name, 'dist', ...path);
  const shipped = (path: string): string => {
    expect(existsSync(path), `the installed package has no "${path}".`);
    return path;
  };
  const withoutNative = copy('install without native');
  rmSync(shipped(packaged(withoutNative, 'vendor', 'better-sqlite3', 'prebuilds')), {
    recursive: true,
  });
  const corrupted = copy('install with corrupt native');
  const prebuild = hostPrebuild();
  writeFileSync(
    shipped(packaged(corrupted, 'vendor', 'better-sqlite3', 'prebuilds', prebuild)),
    'not a native module',
  );
  const withoutJournal = copy('install without journal');
  rmSync(shipped(packaged(withoutJournal, 'drizzle', 'meta', '_journal.json')));

  {
    const configDirectory = join(scratch, 'server config');
    const config = serverConfig(configDirectory, await freePort());
    const serve = (root: string, configPath: string): Server =>
      processes.start(bin(root), ['server', 'serve', '--config', configPath], elsewhere, {
        ...environment,
        RAPHAEL_API_KEY: KEY,
      });

    log('starting the installed server');
    let server = serve(install, config);
    await ready(processes, server, 'raphael server serve');
    const port = /port=(\d+)/.exec(server.stdout())?.[1];
    expect(port !== undefined, `the server did not report its port:\n${server.stdout()}`);
    const endpoint = `http://127.0.0.1:${String(port)}`;
    expect(
      existsSync(join(configDirectory, 'data', 'raphael.sqlite')),
      'the database was not created beside the configuration file.',
    );

    const remote = (root: string, args: readonly string[], key = KEY): Promise<Ran> =>
      cli(root, args, { RAPHAEL_ENDPOINT: endpoint, RAPHAEL_API_KEY: key });
    const json = async (label: string, running: Promise<Ran>): Promise<any> =>
      JSON.parse((await expectSuccess(label, running)).stdout);
    const rootSlugs = async (root: string): Promise<string[]> =>
      (await json('raphael list /', remote(root, ['list', '/', '--json']))).items
        .map((item: { slug: string }) => item.slug)
        .sort();

    log('checking authentication');
    const verifyRequest = async (authorization?: string): Promise<number> => {
      let response;
      try {
        response = await fetch(`${endpoint}/api/connection/verify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: '{}',
          signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
        });
        await response.arrayBuffer();
      } catch (error) {
        throw new PackagingError(
          `the connection check request failed: ${String((error as Error).cause ?? error)}`,
        );
      }
      return response.status;
    };
    expect((await verifyRequest(`Bearer ${KEY}`)) === 200, 'the right key was not accepted.');
    expect((await verifyRequest()) === 401, 'a request without a key was not refused.');
    expect((await verifyRequest(`Bearer ${WRONG_KEY}`)) === 401, 'a wrong key was not refused.');
    const refused = await remote(install, ['get', '/work'], WRONG_KEY);
    expect(
      refused.code === 1 && /unauthorized/.test(refused.stderr),
      describeRun('raphael get with a wrong key (expected a refusal)', refused),
    );

    log('round-tripping create, get, and search');
    expect(
      JSON.stringify(await rootSlugs(install)) === JSON.stringify(SEED_AREAS),
      'a fresh database does not hold exactly the seed areas.',
    );
    await expectSuccess(
      'raphael create area',
      remote(install, ['create', 'area', '/verify', '--title', 'Verify']),
    );
    const created = (
      await json(
        'raphael create note',
        remote(install, [
          'create',
          'resource.note',
          '/verify/probe',
          '--title',
          'Artifact probe',
          '--body',
          'The zebracorn migrates at dawn.',
          '--json',
        ]),
      )
    ).entity;
    const fetched = (await json('raphael get', remote(install, ['get', '/verify/probe', '--json'])))
      .entity;
    expect(fetched.id === created.id, 'the created note could not be read back.');
    const searched = async (root: string): Promise<number[]> =>
      (
        await json(
          'raphael search',
          remote(root, ['search', '/verify', '-r', '-q', 'zebracorn', '--json']),
        )
      ).items.map((hit: { node: { id: number } }) => hit.node.id);
    expect(
      JSON.stringify(await searched(install)) === JSON.stringify([created.id]),
      'full-text search did not find the note.',
    );

    log('checking that a copy without its native driver still works as a client');
    for (const [label, root] of [
      ['native removed', withoutNative],
      ['native corrupted', corrupted],
    ] as const) {
      await expectSuccess(`${label}: raphael --help`, cli(root, ['--help']));
      const version = await expectSuccess(`${label}: raphael --version`, cli(root, ['--version']));
      expect(version.stdout.trim() === manifest.version, `${label}: wrong version reported.`);
      const viaCopy = await json(
        `${label}: raphael get`,
        remote(root, ['get', '/verify/probe', '--json']),
      );
      expect(viaCopy.entity.id === created.id, `${label}: remote get returned the wrong entity.`);
    }

    log('checking that a missing or broken native driver stops the server with context');
    const removed = await refusesToStart(
      processes,
      serve(withoutNative, serverConfig(join(scratch, 'config without native'), await freePort())),
      'serve without native',
    );
    // With no prebuild the loader falls back to the compile-from-source location, which is not shipped.
    expect(
      /better_sqlite3\.node/.test(removed.stderr),
      describeRun('serve without native (expected native-loading context)', removed),
    );
    const broken = await refusesToStart(
      processes,
      serve(corrupted, serverConfig(join(scratch, 'config corrupt native'), await freePort())),
      'serve with corrupt native',
    );
    expect(
      broken.stderr.includes(prebuild),
      describeRun(`serve with corrupt native (expected "${prebuild}")`, broken),
    );
    // The wording is the platform loader's. It is only asserted where it has been observed.
    if (process.platform === 'darwin') {
      expect(/dlopen/.test(broken.stderr), describeRun('serve with corrupt native', broken));
    }

    log('checking that missing migrations stop the server with context');
    const unjournalled = await refusesToStart(
      processes,
      serve(
        withoutJournal,
        serverConfig(join(scratch, 'config without journal'), await freePort()),
      ),
      'serve without journal',
    );
    expect(
      /meta\/_journal\.json/.test(unjournalled.stderr),
      describeRun('serve without journal (expected the journal named)', unjournalled),
    );

    log('stopping the server with SIGTERM');
    const stop = async (running: Server, label: string): Promise<void> => {
      const { ran, forced } = await processes.stop(running);
      expect(!forced, `${label} did not stop within ${String(SHUTDOWN_TIMEOUT_MS)}ms of SIGTERM.`);
      expect(ran.code === 0, describeRun(`${label} after SIGTERM`, ran));
    };
    await stop(server, 'raphael server serve');

    log('restarting on the same database');
    server = serve(install, config);
    await ready(processes, server, 'raphael server serve (restarted)');
    expect(
      JSON.stringify(await rootSlugs(install)) === JSON.stringify([...SEED_AREAS, 'verify'].sort()),
      'after a restart the root does not hold exactly the seed areas and the created one.',
    );
    const again = (await json('raphael get', remote(install, ['get', '/verify/probe', '--json'])))
      .entity;
    expect(again.id === created.id, 'after a restart the note was not found.');
    expect(
      JSON.stringify(await searched(install)) === JSON.stringify([created.id]),
      'after a restart full-text search did not find the note.',
    );
    await stop(server, 'raphael server serve (restarted)');
  }
};

/**
 * Verifies `tarball` and returns what was verified, or throws a `PackagingError` saying what failed.
 * Every process it starts is stopped and every directory it makes is removed, on every path.
 */
export const verifyArtifact = async (
  tarballPath: string,
  options: VerifyOptions = {},
): Promise<VerificationRecord> => {
  if (process.platform === 'win32') {
    throw new PackagingError('artifact verification runs on POSIX hosts only.');
  }
  const log = options.log ?? (() => {});
  const tarball = realpathSync(resolve(tarballPath));
  const integrity = integrityOf(tarball);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readArchiveFile(tarball, 'package/package.json').toString('utf8'));
  } catch (error) {
    if (error instanceof PackagingError) throw error;
    throw new PackagingError('the packaged manifest is not valid JSON.');
  }
  const manifest = checkReleaseManifest(manifestValue, options);

  // A space in every path the artifact will see, and a realpath because macOS's /tmp is a link.
  const processes = new Processes(options.signal);
  processes.checkpoint();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'raphael verify ')));
  log(`working in ${scratch}`);
  try {
    await verifyInstalled(manifest, tarball, scratch, log, processes);
  } catch (error) {
    // Whatever was in flight when the processes were stopped fails in its own way; the cause is the
    // interruption.
    if (options.signal?.aborted === true) throw new PackagingError(INTERRUPTED);
    throw error;
  } finally {
    // Processes first: a server still running could be writing into the directory being removed.
    await processes.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  expect(integrityOf(tarball) === integrity, 'the tarball changed while it was being verified.');
  const detectedLibc = libc();
  return {
    contract: VERIFIER_CONTRACT,
    integrity,
    platform: process.platform,
    arch: process.arch,
    ...(detectedLibc === undefined ? {} : { libc: detectedLibc }),
    node: process.version,
  };
};

export interface Interruption {
  readonly signal: AbortSignal;
  /** The signal that interrupted, if one did. */
  readonly received: () => NodeJS.Signals | undefined;
  /** The conventional exit status for having been stopped by the received signal. */
  readonly exitCode: () => number | undefined;
  readonly dispose: () => void;
}

/**
 * For a command-line entry point only: SIGINT and SIGTERM abort the returned signal instead of
 * killing the process, so that verification can stop what it started and remove what it wrote. A
 * second signal stops immediately, and says that cleanup did not finish.
 */
export const interruptOnSignals = (): Interruption => {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const statusFor = (signal: NodeJS.Signals): number => 128 + constants.signals[signal];
  const handler = (signal: NodeJS.Signals): void => {
    if (received !== undefined) {
      process.stderr.write(
        'Stopping immediately. Cleanup did not finish, so verification processes or temporary ' +
          'files may remain.\n',
      );
      process.exit(statusFor(signal));
    }
    received = signal;
    process.stderr.write(
      `Received ${signal}, stopping and cleaning up. Press again to stop immediately.\n`,
    );
    controller.abort();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    received: () => received,
    exitCode: () => (received === undefined ? undefined : statusFor(received)),
    dispose: () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
};

if (import.meta.main) {
  const usage = 'Usage: node verify.ts <tarball> [--expect-version <version>]';
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { 'expect-version': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${usage}\n`);
    process.exit(2);
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const [tarball, ...extra] = parsed.positionals;
  if (tarball === undefined || extra.length > 0) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  const interruption = interruptOnSignals();
  try {
    const expectedVersion = parsed.values['expect-version'];
    const record = await verifyArtifact(tarball, {
      ...(expectedVersion === undefined ? {} : { version: expectedVersion }),
      log: (line) => process.stderr.write(`verify: ${line}\n`),
      signal: interruption.signal,
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof PackagingError)) throw error;
    process.stderr.write(`Verification failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    interruption.dispose();
  }
  process.exitCode = interruption.exitCode() ?? process.exitCode;
}
