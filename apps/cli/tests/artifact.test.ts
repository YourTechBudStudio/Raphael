import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { integrityOf, pack } from '../packaging/archive.ts';
import { PackagingError } from '../packaging/errors.ts';
import { RELEASE_NAME } from '../packaging/manifest.ts';
import { packageRelease } from '../packaging/package.ts';
import { checkRelease, RELEASE_METADATA } from '../packaging/receipt.ts';
import { VERIFIER_CONTRACT, verifyArtifact } from '../packaging/verify.ts';

/**
 * The real artifact, made and verified the way `pnpm package` makes it, into a directory of its own.
 *
 * Packaging runs the behavioural verifier on the installed tarball before it writes the receipt, so a
 * receipt here is the evidence that the clean install, the server lifecycle, and the native and
 * migration refusals all passed. The workspace libraries are not rebuilt (`pnpm test` has built them,
 * and rebuilding would rewrite files that other test files are importing); nothing else is skipped.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
  engines: { node: string };
};
const expected = { version: rootManifest.version, engines: rootManifest.engines.node };

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const scratch = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'raphael artifact ')));
  directories.push(directory);
  return directory;
};

const SOURCES = ['package.json', 'apps/cli/package.json', 'pnpm-lock.yaml'];
const digests = (): Record<string, string> =>
  Object.fromEntries(
    SOURCES.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(repoRoot, file)))
        .digest('hex'),
    ]),
  );

const refuses = (run: () => unknown, pattern: RegExp): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof PackagingError && pattern.test(error.message),
  );
};

let releaseDir = '';
let receipt: Record<string, any> = {};
const sourcesBefore = digests();

before(async () => {
  releaseDir = join(scratch(), 'release');
  await packageRelease(repoRoot, releaseDir, { buildDependencies: false });
  receipt = JSON.parse(readFileSync(join(releaseDir, RELEASE_METADATA), 'utf8'));
});

describe('the packaged and verified artifact', () => {
  it('has a receipt naming the tarball beside it, the root version, and what was verified', () => {
    assert.equal(receipt.name, RELEASE_NAME);
    assert.equal(receipt.version, rootManifest.version);
    assert.equal(receipt.tarball, `yourtechbudstudio-raphael-${rootManifest.version}.tgz`);
    const tarball = join(releaseDir, receipt.tarball);
    assert.equal(integrityOf(tarball), receipt.integrity);
    assert.deepEqual(
      { ...receipt.verification, node: undefined, libc: undefined },
      {
        contract: VERIFIER_CONTRACT,
        integrity: receipt.integrity,
        platform: process.platform,
        arch: process.arch,
        node: undefined,
        libc: undefined,
      },
    );
    assert.equal(receipt.verification.node, process.version);
    assert.equal(checkRelease(releaseDir, expected).tarball, tarball);
  });

  it('packages again over stale output without keeping it or touching the sources', async () => {
    writeFileSync(join(releaseDir, 'package', 'dist', 'stale.js'), 'export {};\n');
    writeFileSync(join(releaseDir, 'package', 'stale.txt'), 'stale\n');
    writeFileSync(join(releaseDir, 'yourtechbudstudio-raphael-0.0.0-stale.tgz'), 'stale');
    await packageRelease(repoRoot, releaseDir, { buildDependencies: false });

    assert.equal(existsSync(join(releaseDir, 'package', 'dist', 'stale.js')), false);
    assert.equal(existsSync(join(releaseDir, 'package', 'stale.txt')), false);
    assert.equal(existsSync(join(releaseDir, 'yourtechbudstudio-raphael-0.0.0-stale.tgz')), false);
    const repackaged = JSON.parse(readFileSync(join(releaseDir, RELEASE_METADATA), 'utf8'));
    assert.equal(
      repackaged.files.some((file: { path: string }) => file.path.includes('stale')),
      false,
    );
    checkRelease(releaseDir, expected);
    assert.deepEqual(digests(), sourcesBefore);
  });
});

describe('the receipt authorizes only the artifact it describes', () => {
  /** A copy of the real release directory, altered by `change`. */
  const altered = (change: (directory: string, metadata: Record<string, any>) => void): string => {
    const directory = join(scratch(), 'release');
    cpSync(releaseDir, directory, { recursive: true });
    const metadata = JSON.parse(readFileSync(join(directory, RELEASE_METADATA), 'utf8'));
    change(directory, metadata);
    writeFileSync(join(directory, RELEASE_METADATA), JSON.stringify(metadata));
    return directory;
  };

  it('refuses a tarball that changed after it was verified', () => {
    const directory = altered((root, metadata) => {
      appendFileSync(join(root, metadata.tarball), Buffer.from([0]));
    });
    refuses(() => checkRelease(directory, expected), /not the tarball that was packaged/);
  });

  it('refuses a receipt without a verification record, or from another verifier contract', () => {
    refuses(
      () =>
        checkRelease(
          altered((_root, metadata) => delete metadata.verification),
          expected,
        ),
      /no verification record/,
    );
    refuses(
      () =>
        checkRelease(
          altered((_root, metadata) => (metadata.verification.contract = VERIFIER_CONTRACT - 1)),
          expected,
        ),
      /contract/,
    );
    refuses(
      () =>
        checkRelease(
          altered((_root, metadata) => (metadata.verification.integrity = 'sha512-other')),
          expected,
        ),
      /different tarball/,
    );
  });

  it('refuses a different version or identity', () => {
    refuses(
      () => checkRelease(releaseDir, { ...expected, version: '99.0.0' }),
      /not @yourtechbudstudio\/raphael@99\.0\.0/,
    );
    refuses(
      () =>
        checkRelease(
          altered((_root, metadata) => (metadata.name = 'raphael')),
          expected,
        ),
      /release metadata is for raphael@/,
    );
    refuses(() => checkRelease(releaseDir, { ...expected, engines: '>=24' }), /"engines"/);
  });

  it('refuses a tarball path that leaves the release directory', () => {
    for (const tarball of ['../outside.tgz', '/tmp/outside.tgz', 'nested/x.tgz', '.hidden.tgz']) {
      refuses(
        () =>
          checkRelease(
            altered((_root, metadata) => (metadata.tarball = tarball)),
            expected,
          ),
        /not a tarball beside it/,
      );
    }
    refuses(
      () =>
        checkRelease(
          altered((root, metadata) => rmSync(join(root, metadata.tarball))),
          expected,
        ),
      /missing or is not a regular file/,
    );
    refuses(() => checkRelease(scratch(), expected), /run "pnpm package"/);
  });
});

describe('the verifier', () => {
  it('fails an artifact that installs but cannot run its server, and one with another version', async () => {
    // The real stage without one journalled migration: a complete-looking package that cannot start.
    const root = scratch();
    const stage = join(root, 'package');
    cpSync(join(releaseDir, 'package'), stage, { recursive: true });
    const drizzle = join(stage, 'dist', 'drizzle');
    const migration = readdirSync(drizzle).find((file) => file.endsWith('.sql'));
    assert.ok(migration !== undefined);
    rmSync(join(drizzle, migration));
    const tarball = join(root, pack(stage, root).filename);

    await assert.rejects(
      verifyArtifact(tarball, expected),
      (error: unknown) =>
        error instanceof PackagingError && /raphael server serve exited/.test(error.message),
    );
    await assert.rejects(
      verifyArtifact(join(releaseDir, receipt.tarball), { ...expected, version: '99.0.0' }),
      (error: unknown) => error instanceof PackagingError && /not the expected/.test(error.message),
    );
  });
});

describe('interrupting verification', () => {
  it('stops the servers it started and removes its files before exiting on SIGTERM', async () => {
    const verifier = spawn(
      process.execPath,
      [join(repoRoot, 'apps', 'cli', 'packaging', 'verify.ts'), join(releaseDir, receipt.tarball)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
      verifier.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    try {
      // Interrupted once its installed server is serving, which is when an orphan would be left.
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(
          () => rejectReady(new Error(`never got ready:\n${stderr}`)),
          60_000,
        );
        verifier.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (stderr.includes('verify: checking authentication')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        void exited.then(() => rejectReady(new Error(`exited early:\n${stderr}`)));
      });
      const scratchDir = /verify: working in (.+)\n/.exec(stderr)?.[1];
      assert.ok(scratchDir !== undefined, stderr);
      assert.ok(existsSync(scratchDir));
      const running = (): string[] =>
        spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
          .stdout.split('\n')
          .filter((line) => line.includes(scratchDir));
      assert.ok(running().length > 0, 'the installed server should be running before the signal');

      verifier.kill('SIGTERM');
      const outcome = await Promise.race([
        exited,
        new Promise<'timeout'>((resolveTimeout) =>
          setTimeout(() => resolveTimeout('timeout'), 45_000),
        ),
      ]);
      assert.notEqual(outcome, 'timeout', 'the verifier did not finish cleaning up in time');
      assert.deepEqual(outcome, { code: 143, signal: null }, stderr);
      assert.match(stderr, /Received SIGTERM, stopping and cleaning up/);
      assert.match(stderr, /Verification failed: verification was interrupted\./);
      assert.deepEqual(running(), []);
      assert.equal(existsSync(scratchDir), false);
    } finally {
      if (verifier.exitCode === null && verifier.signalCode === null) {
        verifier.kill('SIGKILL');
        await exited;
      }
    }
  });
});
