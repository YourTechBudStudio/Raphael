/**
 * What this copy of Raphael is, and where its shipped assets live.
 *
 * This is the one module that differs between a checkout and the published package. Here, in the
 * workspace, the version is the repository root's - the root manifest is the only release-version
 * authority - and the backend finds its migrations beside its own sources. The packager substitutes
 * `packaging/distribution.packaged.ts`, which answers the same two questions from the generated
 * manifest and the assets staged beside the bundle. Nothing else knows the difference.
 *
 * Both answers are computed on demand, so `raphael --help` still reads nothing at all.
 */

import { readManifestVersion } from './shared/manifest.ts';

/**
 * `src/distribution.ts` and the compiled `dist/distribution.js` both sit three levels below the
 * repository root, so one URL serves both.
 */
export const version = (): string =>
  readManifestVersion(new URL('../../../package.json', import.meta.url));

/** The backend's own default is correct in a checkout, so nothing is overridden. */
export const migrationsFolder = (): string | undefined => undefined;
