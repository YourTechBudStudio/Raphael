/**
 * Bounded external work, and cleanup that happens whatever the outcome.
 *
 * Everything this harness drives is a real external process - a package manager reaching a registry,
 * a compiler, a server binding a port. Any of them can hang, and a hung acceptance run is worse than
 * a failed one: it looks like progress. So every command here carries a deadline, and exceeding it is
 * a failure with the output captured up to that point, never a wait that someone eventually notices.
 *
 * The other rule is that nothing outlives the run. Temporary directories and child processes are
 * registered as they are created and released in reverse, so an assertion that throws half way
 * through still leaves the machine as it found it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Ran {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Passed to the child on stdin, then closed. Absent means stdin is closed immediately. */
  readonly input?: string;
}

/** Registered cleanups, released newest first. */
const cleanups: Array<() => void> = [];

export const onCleanup = (release: () => void): void => {
  cleanups.push(release);
};

export const releaseAll = (): void => {
  for (const release of cleanups.reverse()) {
    try {
      release();
    } catch {
      // A cleanup that fails must not stop the ones behind it. There is nothing useful to report
      // here: the run is already over, and the alternative is leaking every remaining resource.
    }
  }
  cleanups.length = 0;
};

/**
 * A temporary directory this run owns, resolved through `realpath`.
 *
 * The resolution matters on macOS, where the temporary directory is reached through a symbolic link:
 * a path the harness holds and a path a child process reports would otherwise be different strings
 * for one directory, and assertions comparing them would fail for no real reason.
 */
export const temporaryDirectory = (label: string): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `raphael-acceptance-${label}-`)));
  onCleanup(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** Run a command to completion, or fail at the deadline. Never inherits this process's environment. */
export const run = (
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Ran> => {
  const { cwd, env = {}, timeoutMs = 300_000, input } = options;
  return new Promise<Ran>((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
};

/** Run, and fail loudly with the captured output if it did not succeed. */
export const runOrThrow = async (
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Ran> => {
  const ran = await run(command, args, options);
  if (ran.code !== 0) {
    const why = ran.timedOut
      ? `timed out after ${options.timeoutMs ?? 300_000}ms`
      : `exit ${ran.code}`;
    throw new Error(
      `${command} ${args.join(' ')} ${why}\n--- stdout ---\n${ran.stdout}\n--- stderr ---\n${ran.stderr}`,
    );
  }
  return ran;
};

/** A long-lived child this run owns. Killed on cleanup if it is still alive. */
export const own = (child: ChildProcess): ChildProcess => {
  onCleanup(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return child;
};

/** Wait for a condition, with a bound, so a failure is a failure rather than a hang. */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
};
