/**
 * The packaged replacement for `src/distribution.ts`; see that module for the contract.
 *
 * Every bundle chunk is emitted flat into the package's `dist/`, so whichever chunk this lands in,
 * the generated manifest is one level up and the staged migrations are beside it. Nothing here
 * depends on the working directory or on where the package was installed.
 */

import { fileURLToPath } from 'node:url';

import { readManifestVersion } from '../src/shared/manifest.ts';

export const version = (): string =>
  readManifestVersion(new URL('../package.json', import.meta.url));

export const migrationsFolder = (): string => fileURLToPath(new URL('./drizzle', import.meta.url));
