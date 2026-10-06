/**
 * The checks `publish.sh` delegates, so the shell stays a sequence of commands.
 *
 *   node apps/cli/packaging/release.ts version
 *     Prints the root version, refused unless it is a semantic version.
 *
 *   node apps/cli/packaging/release.ts artifact <version>
 *     Refuses if the root version is no longer <version>, then checks `release/release.json` and the
 *     tarball it names, and prints that tarball's absolute path.
 *
 * Every refusal is a message on stderr and exit 1, which stops `publish.sh` before npm is involved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PackagingError } from './errors.ts';
import { releaseEngines, releaseVersion } from './manifest.ts';
import { checkRelease } from './receipt.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const rootManifest = (): unknown => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    throw new PackagingError('the root package.json is missing or is not JSON.');
  }
};

const main = (argv: readonly string[]): string => {
  const [command, ...rest] = argv;
  if (command === 'version' && rest.length === 0) return releaseVersion(rootManifest());
  if (command === 'artifact' && rest.length === 1) {
    const captured = rest[0] as string;
    const root = rootManifest();
    const current = releaseVersion(root);
    if (current !== captured) {
      throw new PackagingError(
        `the root version changed from ${JSON.stringify(captured)} to ${JSON.stringify(current)} during the release.`,
      );
    }
    return checkRelease(join(repoRoot, 'release'), {
      version: current,
      engines: releaseEngines(root),
    }).tarball;
  }
  throw new PackagingError('usage: release.ts version | release.ts artifact <version>');
};

try {
  process.stdout.write(`${main(process.argv.slice(2))}\n`);
} catch (error) {
  if (!(error instanceof PackagingError)) throw error;
  process.stderr.write(`Release check failed: ${error.message}\n`);
  process.exitCode = 1;
}
