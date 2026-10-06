import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { integrityOf, pack } from '../packaging/archive.ts';
import { BIN_PATH, NOTICES_FILE, releaseManifest } from '../packaging/manifest.ts';
import { RELEASE_METADATA } from '../packaging/receipt.ts';
import { VERIFIER_CONTRACT } from '../packaging/verify.ts';

/**
 * `publish.sh`, run for real against disposable repository roots.
 *
 * `pnpm` and `npm` are stubs placed first on `PATH`: they record every call, and `npm` never reaches
 * a registry, in success cases as much as failure ones. The stub `pnpm package` installs a prepared
 * release directory holding a real tarball made by `npm pack` and a receipt, so every refusal comes
 * from the real release helper reading a real archive. Each root has a space in its path, and the
 * script is always invoked from somewhere else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const ROOT_VERSION = '2.0.0';
const ROOT = {
  name: 'raphael',
  version: ROOT_VERSION,
  private: true,
  description: 'An actionable second brain.',
  author: 'YourTechBud',
  engines: { node: '>=26 <27' },
};
/** Deliberately different: the root, not the CLI manifest, is the release version. */
const CLI = {
  name: '@yourtechbudstudio/raphael',
  version: '9.9.9',
  private: true,
  bin: { raphael: './dist/main.js' },
};

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
};

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const PNPM_STUB = `#!/usr/bin/env bash
set -u
{ printf 'pnpm'; printf '\\t%s' "$@"; printf '\\t@%s\\n' "$PWD"; } >> "$STUB_LOG"
case "\${1:-}" in
  check) exit "\${STUB_CHECK_EXIT:-0}" ;;
  package)
    if [[ -n "\${STUB_PACKAGE_EXIT:-}" ]]; then exit "$STUB_PACKAGE_EXIT"; fi
    rm -rf release
    cp -R "$STUB_RELEASE" release
    if [[ -n "\${STUB_ROOT_VERSION:-}" ]]; then
      node -e 'const fs = require("fs"); const m = JSON.parse(fs.readFileSync("package.json", "utf8")); m.version = process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(m));' "$STUB_ROOT_VERSION"
    fi
    exit 0 ;;
esac
exit 99
`;

const NPM_STUB = `#!/usr/bin/env bash
set -u
{ printf 'npm'; printf '\\t%s' "$@"; printf '\\t@%s\\n' "$PWD"; } >> "$STUB_LOG"
exit "\${STUB_NPM_EXIT:-0}"
`;

/** A release directory as `pnpm package` leaves it, for a package at `version`. */
const prepareRelease = (
  version: string,
  change: (directory: string, metadata: Record<string, any>) => void = () => {},
): string => {
  const directory = join(scratch('raphael stub release '), 'release');
  const stage = join(directory, 'package');
  write(
    join(stage, 'package.json'),
    JSON.stringify(releaseManifest({ ...ROOT, version }, CLI), null, 2),
  );
  write(join(stage, BIN_PATH), '#!/usr/bin/env node\n');
  chmodSync(join(stage, BIN_PATH), 0o755);
  write(join(stage, NOTICES_FILE), 'notices\n');
  const packed = pack(stage, directory);
  const integrity = integrityOf(join(directory, packed.filename));
  const metadata: Record<string, any> = {
    name: CLI.name,
    version,
    bin: 'raphael',
    tarball: packed.filename,
    integrity,
    shasum: packed.shasum,
    size: packed.size,
    files: [],
    verification: {
      contract: VERIFIER_CONTRACT,
      integrity,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
  };
  change(directory, metadata);
  writeFileSync(join(directory, RELEASE_METADATA), JSON.stringify(metadata));
  return directory;
};

interface Fixture {
  readonly root: string;
  readonly log: string;
  readonly bin: string;
}

/** A disposable repository root with the real script and release tooling, and stubbed commands. */
const fixture = (rootManifest: object = ROOT): Fixture => {
  const root = join(scratch('raphael publish '), 'repo root');
  mkdirSync(root, { recursive: true });
  copyFileSync(join(repoRoot, 'publish.sh'), join(root, 'publish.sh'));
  chmodSync(join(root, 'publish.sh'), 0o755);
  cpSync(join(repoRoot, 'apps', 'cli', 'packaging'), join(root, 'apps', 'cli', 'packaging'), {
    recursive: true,
  });
  write(join(root, 'package.json'), JSON.stringify(rootManifest));
  write(join(root, 'apps', 'cli', 'package.json'), JSON.stringify(CLI));

  const bin = join(root, '..', 'stub bin');
  write(join(bin, 'pnpm'), PNPM_STUB);
  write(join(bin, 'npm'), NPM_STUB);
  chmodSync(join(bin, 'pnpm'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  const log = join(root, '..', 'calls.log');
  writeFileSync(log, '');
  return { root, log, bin };
};

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Each recorded call as its arguments, the working directory last. */
  readonly calls: string[][];
}

const publish = (
  fixtureRoot: Fixture,
  args: readonly string[],
  env: Record<string, string> = {},
): Ran => {
  const elsewhere = scratch('raphael caller cwd ');
  const ran = spawnSync(join(fixtureRoot.root, 'publish.sh'), args, {
    cwd: elsewhere,
    env: {
      PATH: `${fixtureRoot.bin}:${process.env.PATH ?? ''}`,
      HOME: elsewhere,
      STUB_LOG: fixtureRoot.log,
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  const calls = readFileSync(fixtureRoot.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, calls };
};

const commands = (ran: Ran): string[] => ran.calls.map((call) => call.slice(0, 2).join(' '));
const published = (ran: Ran): boolean => ran.calls.some((call) => call[1] === 'publish');

describe('publish.sh', () => {
  it('parses as Bash and is executable', () => {
    const syntax = spawnSync('bash', ['-n', join(repoRoot, 'publish.sh')], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const mode = spawnSync('test', ['-x', join(repoRoot, 'publish.sh')]);
    assert.equal(mode.status, 0);
  });

  it('checks, packages, and dry-runs npm publish on the exact verified tarball, from any cwd', () => {
    const root = fixture();
    const release = prepareRelease(ROOT_VERSION);
    // A decoy that a glob or "newest file" choice would pick.
    copyFileSync(
      join(release, `yourtechbudstudio-raphael-${ROOT_VERSION}.tgz`),
      join(release, 'yourtechbudstudio-raphael-9.9.9.tgz'),
    );
    const ran = publish(root, ['--dry-run'], { STUB_RELEASE: release });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(commands(ran), ['pnpm check', 'pnpm package', 'npm publish']);
    for (const call of ran.calls) assert.equal(call.at(-1), `@${root.root}`);
    const tarball = join(root.root, 'release', `yourtechbudstudio-raphael-${ROOT_VERSION}.tgz`);
    assert.deepEqual(ran.calls[2]?.slice(1, -1), [
      'publish',
      tarball,
      '--access',
      'public',
      '--ignore-scripts',
      '--dry-run',
    ]);
    assert.match(ran.stdout, /Package: {2}@yourtechbudstudio\/raphael/);
    assert.match(ran.stdout, new RegExp(`Version: {2}${ROOT_VERSION.replaceAll('.', '\\.')}\\n`));
    assert.ok(ran.stdout.includes(`Artifact: ${tarball}`));
    assert.match(ran.stdout, /Mode: {5}dry run/);
  });

  it('publishes without --dry-run by default, and forwards npm’s exit status unchanged', () => {
    const root = fixture();
    const release = prepareRelease(ROOT_VERSION);
    const ran = publish(root, [], { STUB_RELEASE: release, STUB_NPM_EXIT: '7' });
    assert.equal(ran.code, 7);
    assert.deepEqual(ran.calls[2]?.slice(1, -1), [
      'publish',
      join(root.root, 'release', `yourtechbudstudio-raphael-${ROOT_VERSION}.tgz`),
      '--access',
      'public',
      '--ignore-scripts',
    ]);
    assert.match(ran.stdout, /Mode: {5}publish\n/);
    assert.equal(ran.calls.filter((call) => call[1] === 'publish').length, 1, 'no retry');
  });

  it('shows help, and refuses an unsupported argument, before running anything', () => {
    const help = publish(fixture(), ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: \.\/publish\.sh \[--dry-run\]/);
    assert.deepEqual(help.calls, []);

    for (const args of [['--force'], ['--dry-run', 'extra'], ['--tag=next']]) {
      const ran = publish(fixture(), args);
      assert.equal(ran.code, 2, args.join(' '));
      assert.match(ran.stderr, /Unknown argument/);
      assert.deepEqual(ran.calls, []);
    }
  });

  it('refuses an invalid root version before running anything', () => {
    const ran = publish(fixture({ ...ROOT, version: 'v2' }), ['--dry-run']);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /not a semantic version/);
    assert.deepEqual(ran.calls, []);
  });

  it('stops before packaging when checks fail, and before publishing when packaging fails', () => {
    const failedCheck = publish(fixture(), ['--dry-run'], { STUB_CHECK_EXIT: '1' });
    assert.notEqual(failedCheck.code, 0);
    assert.deepEqual(commands(failedCheck), ['pnpm check']);

    const failedPackage = publish(fixture(), ['--dry-run'], { STUB_PACKAGE_EXIT: '1' });
    assert.notEqual(failedPackage.code, 0);
    assert.deepEqual(commands(failedPackage), ['pnpm check', 'pnpm package']);
  });

  it('refuses when the root version changes during the release', () => {
    const ran = publish(fixture(), ['--dry-run'], {
      STUB_RELEASE: prepareRelease(ROOT_VERSION),
      STUB_ROOT_VERSION: '2.0.1',
    });
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /root version changed from "2\.0\.0" to "2\.0\.1"/);
    assert.equal(published(ran), false);
  });

  it('refuses an artifact the receipt does not authorize, through the real release helper', () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        'tampered tarball',
        prepareRelease(ROOT_VERSION, (directory, metadata) =>
          appendFileSync(join(directory, metadata.tarball), Buffer.from([0])),
        ),
        /not the tarball that was packaged and verified/,
      ],
      [
        'unverified',
        prepareRelease(ROOT_VERSION, (_directory, metadata) => delete metadata.verification),
        /no verification record/,
      ],
      [
        'receipt for another tarball',
        prepareRelease(ROOT_VERSION, (_directory, metadata) => {
          metadata.verification.integrity = 'sha512-other';
        }),
        /different tarball/,
      ],
      [
        'another version, consistently packaged',
        prepareRelease('1.0.0'),
        /not @yourtechbudstudio\/raphael@2\.0\.0/,
      ],
      [
        'packaged manifest at another version',
        prepareRelease('1.0.0', (_directory, metadata) => (metadata.version = ROOT_VERSION)),
        /packaged version "1\.0\.0" is not the expected "2\.0\.0"/,
      ],
      [
        'escaping path',
        prepareRelease(ROOT_VERSION, (_directory, metadata) => {
          metadata.tarball = '../yourtechbudstudio-raphael-2.0.0.tgz';
        }),
        /not a tarball beside it/,
      ],
    ];
    for (const [label, release, pattern] of cases) {
      const ran = publish(fixture(), ['--dry-run'], { STUB_RELEASE: release });
      assert.equal(ran.code, 1, label);
      assert.match(ran.stderr, pattern, label);
      assert.deepEqual(commands(ran), ['pnpm check', 'pnpm package'], label);
    }
  });
});
