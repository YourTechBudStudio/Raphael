/**
 * Driving an installed Raphael server, and the CLI that talks to it.
 *
 * The server started here is the installed binary, not the workspace source and not the backend
 * imported as a library. It runs from a directory that is neither the installation nor the
 * repository, so anything it finds it found the way an installed copy would.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { own, run, waitFor, type Ran } from './bounded.ts';
import { isolatedEnvironment, type Installation } from './install.ts';

/**
 * A port the operating system chose, released before the server is told to bind it.
 *
 * A configuration file may not ask for port 0 - an arbitrary port is useless to an operator whose
 * clients need a fixed address - and weakening that rule to make testing easier would test a server
 * nobody runs. So the port is allocated, read, and released here. There is a race: something else
 * could take it in the gap. It has not been observed, it would appear as a bind failure rather than a
 * silent pass, and it is the honest cost of not relaxing the production contract.
 */
export const allocatePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not read an allocated port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

/**
 * How to invoke the installed command.
 *
 * `node_modules/.bin/raphael` is a shell shim, not a JavaScript file, so it is executed rather than
 * handed to `node` - and executing it is what a person installing Raphael actually does, which makes
 * it the right default. A run that needs options for the Node process itself cannot go through the
 * shim, so it addresses the installed entry point directly. Both are inside the installation; neither
 * reaches this repository.
 */
export const invoke = (
  installation: Installation,
  args: readonly string[],
  nodeOptions: readonly string[],
): { readonly command: string; readonly args: readonly string[] } =>
  nodeOptions.length === 0
    ? { command: installation.binary, args: [...args] }
    : { command: process.execPath, args: [...nodeOptions, installation.entry, ...args] };

/**
 * The longest any shutdown here may take.
 *
 * Comfortably past the backend's own 10-second drain deadline, so an ordinary slow shutdown is never
 * mistaken for a stuck one, and far short of a test runner giving up - the difference between a
 * failure that names what was on stdout and a run that simply stops making progress.
 */
const SHUTDOWN_DEADLINE_MS = 30_000;

/**
 * Await something that ought to finish, escalate if it does not, and fail with what was captured.
 *
 * `escalate` runs first so the resource is actually released - a child that ignored SIGINT is sent
 * SIGKILL - and only then is the failure raised. Reporting without escalating would leave the process
 * behind; escalating without reporting would hide that the deadline was ever reached.
 */
const withinDeadline = async <A>(
  work: Promise<A>,
  timeoutMs: number,
  escalate: () => void,
  describe: () => string,
): Promise<A> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      escalate();
      reject(new Error(describe()));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export interface ServerHandle {
  readonly port: number;
  readonly endpoint: string;
  readonly key: string;
  readonly configFile: string;
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly pid: number | undefined;
  /** Send a signal and return immediately, for tests that need to observe what happens next. */
  readonly signal: (signal: NodeJS.Signals) => void;
  /**
   * Wait for the process to exit, bounded, without asking it to.
   *
   * For tests that have already arranged the exit themselves and only need to observe it. Waiting on
   * the raw exit promise instead would reintroduce exactly the hazard the deadlines exist for: a
   * termination that deadlocks is what these tests are built to expose, and an unbounded wait turns
   * that discovery into a suite that hangs.
   */
  readonly awaitExit: () => Promise<number | null>;
  /**
   * Ensure a graceful shutdown has been asked for, then wait for it, bounded.
   *
   * Asking twice is not the same as asking once and waiting. Raphael treats a second SIGINT during
   * shutdown as an instruction to stop immediately - it exits 130 without awaiting cleanup, and says
   * so - which is exactly right for someone pressing Ctrl-C twice and exactly wrong for a test that
   * is trying to observe orderly shutdown. So a stop that follows an explicit `signal` waits for the
   * shutdown already under way rather than starting a forced one, and a test can no longer race
   * itself onto the escalation path and invalidate the very evidence it was collecting.
   */
  readonly stop: () => Promise<number | null>;
  /** SIGKILL. No cleanup runs; this is what a crash looks like. */
  readonly kill: () => Promise<void>;
}

export interface ServerOptions {
  /** Reuse an existing configuration directory, which is how a restart reaches the same database. */
  readonly configDirectory?: string;
  readonly port?: number;
  readonly key?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Extra arguments to `node`, before the script. Used for the blocked-driver case. */
  readonly nodeOptions?: readonly string[];
}

/**
 * A generated throwaway credential.
 *
 * Never a fixed literal: a key that is checked in is a key someone eventually runs a real server
 * with. Nothing in this harness writes it to a tracked file.
 */
export const generateKey = (): string =>
  `acceptance-${Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;

/**
 * Write a configuration file with a deliberately relative database path.
 *
 * Relative is the point: the server is started from a foreign directory, so a database that lands
 * beside the configuration file proves resolution happens against the file's directory, and one that
 * lands beside the invocation proves it does not.
 */
export const writeConfig = (directory: string, port: number): string => {
  mkdirSync(join(directory, 'store'), { recursive: true });
  const file = join(directory, 'raphael.yaml');
  writeFileSync(
    file,
    `server:\n  host: 127.0.0.1\n  port: ${port}\ndatabase:\n  path: ./store/raphael.sqlite\n`,
  );
  return file;
};

export const startServer = async (
  installation: Installation,
  options: ServerOptions = {},
): Promise<ServerHandle> => {
  const { configDirectory = installation.foreignCwd, nodeOptions = [], extraEnv = {} } = options;
  const port = options.port ?? (await allocatePort());
  const key = options.key ?? generateKey();
  const configFile = writeConfig(configDirectory, port);

  const invocation = invoke(installation, ['server', 'serve', '--config', configFile], nodeOptions);
  const child = own(
    spawn(invocation.command, invocation.args, {
      cwd: installation.foreignCwd,
      env: isolatedEnvironment(installation, { RAPHAEL_API_KEY: key, ...extraEnv }),
      stdio: 'pipe',
    }),
  );

  let stdout = '';
  let stderr = '';
  // Whether an orderly shutdown has already been asked for, so it is never asked for twice.
  let shutdownRequested = false;
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  // Deliberately not published on the handle. Every wait on it must carry a deadline, and the way to
  // guarantee that is to make the unbounded promise unreachable from a test rather than to remember.
  const exited = new Promise<number | null>((resolve) =>
    child.on('close', (code) => resolve(code)),
  );

  const awaitExit = async (): Promise<number | null> => {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    // The deadline escalates the way a person would, and then reports rather than waits.
    return await withinDeadline(
      exited,
      SHUTDOWN_DEADLINE_MS,
      () => {
        child.kill('SIGKILL');
      },
      () =>
        `the server did not exit within ${SHUTDOWN_DEADLINE_MS}ms.\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  };

  const handle: ServerHandle = {
    port,
    awaitExit,
    endpoint: `http://127.0.0.1:${port}`,
    key,
    configFile,
    configDirectory,
    databasePath: join(configDirectory, 'store', 'raphael.sqlite'),
    stdout: () => stdout,
    stderr: () => stderr,
    pid: child.pid,
    signal: (which) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (which === 'SIGINT' || which === 'SIGTERM') shutdownRequested = true;
      child.kill(which);
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      if (!shutdownRequested) {
        shutdownRequested = true;
        child.kill('SIGINT');
      }
      return await awaitExit();
    },
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await awaitExit();
    },
  };
  return handle;
};

/** Wait until the server says it is listening, or fail with whatever it said instead. */
export const awaitListening = async (handle: ServerHandle): Promise<void> => {
  await waitFor(
    () => handle.stdout().includes('server.listening') || handle.stderr().length > 0,
    'the installed server to report it is listening',
    60_000,
  );
  if (!handle.stdout().includes('server.listening')) {
    throw new Error(`server did not start:\n${handle.stdout()}\n${handle.stderr()}`);
  }
};

export interface CliOptions {
  readonly connected?: ServerHandle;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly nodeOptions?: readonly string[];
}

/** Run the installed `raphael`, from a foreign directory, with nothing inherited. */
export const raphael = async (
  installation: Installation,
  args: readonly string[],
  options: CliOptions = {},
): Promise<Ran> => {
  const { connected, env = {}, cwd = installation.foreignCwd, nodeOptions = [] } = options;
  const connection =
    connected === undefined
      ? {}
      : { RAPHAEL_ENDPOINT: connected.endpoint, RAPHAEL_API_KEY: connected.key };
  const invocation = invoke(installation, args, nodeOptions);
  return await run(invocation.command, invocation.args, {
    cwd,
    env: isolatedEnvironment(installation, { ...connection, ...env }),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
};

/** Run the installed CLI and parse its JSON, failing with the output if it did not succeed. */
export const raphaelJson = async (
  installation: Installation,
  args: readonly string[],
  options: CliOptions = {},
): Promise<unknown> => {
  const ran = await raphael(installation, [...args, '--json'], options);
  if (ran.code !== 0) {
    throw new Error(
      `raphael ${args.join(' ')} exited ${ran.code}\n--- stdout ---\n${ran.stdout}\n--- stderr ---\n${ran.stderr}`,
    );
  }
  return JSON.parse(ran.stdout);
};
