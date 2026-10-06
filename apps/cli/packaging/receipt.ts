/**
 * `release.json`, read back: the receipt that authorizes publishing one exact tarball.
 *
 * Packaging writes it last, after the installed tarball passed verification, so a receipt without a
 * verification record is from something other than a finished `pnpm package` and authorizes nothing.
 * The tarball is named relative to the receipt's own directory and must sit directly in it.
 *
 * What this establishes is consistency: the tarball on disk is the one that was packaged and verified,
 * under the identity and version the caller expects, by the verification contract this checkout
 * defines. It is not a signature. Someone who deliberately rewrites both the tarball and the receipt
 * is not what it guards against.
 */

import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { integrityOf, readArchiveFile } from './archive.ts';
import { PackagingError } from './errors.ts';
import { checkReleaseManifest, RELEASE_NAME, type ReleaseManifest } from './manifest.ts';
import { VERIFIER_CONTRACT } from './verify.ts';

export const RELEASE_METADATA = 'release.json';

export interface CheckedRelease {
  /** Absolute path of the tarball the receipt authorizes. */
  readonly tarball: string;
  readonly manifest: ReleaseManifest;
}

const object = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PackagingError(`${label} is not a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

/** Checks `<releaseDir>/release.json` and the tarball it names against what the caller expects. */
export const checkRelease = (
  releaseDir: string,
  expected: { readonly version: string; readonly engines: string },
): CheckedRelease => {
  const metadataPath = join(releaseDir, RELEASE_METADATA);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new PackagingError(`"${metadataPath}" is missing or is not JSON; run "pnpm package".`);
  }
  const receipt = object(parsed, 'the release metadata');
  if (receipt.name !== RELEASE_NAME || receipt.version !== expected.version) {
    throw new PackagingError(
      `the release metadata is for ${String(receipt.name)}@${String(receipt.version)}, ` +
        `not ${RELEASE_NAME}@${expected.version}.`,
    );
  }

  const name = receipt.tarball;
  if (
    typeof name !== 'string' ||
    name !== basename(name) ||
    name.includes('\\') ||
    name.startsWith('.') ||
    !name.endsWith('.tgz')
  ) {
    throw new PackagingError(
      `the release metadata names ${JSON.stringify(name)}, not a tarball beside it.`,
    );
  }
  const tarball = join(releaseDir, name);
  let isFile = false;
  try {
    isFile = lstatSync(tarball).isFile();
  } catch {
    // Reported below.
  }
  if (!isFile) throw new PackagingError(`"${tarball}" is missing or is not a regular file.`);

  const verification = receipt.verification;
  if (verification === undefined) {
    throw new PackagingError(
      'the release metadata has no verification record; run "pnpm package".',
    );
  }
  const record = object(verification, 'the verification record');
  if (record.contract !== VERIFIER_CONTRACT) {
    throw new PackagingError(
      `the tarball was verified under contract ${String(record.contract)}, ` +
        `not the current ${String(VERIFIER_CONTRACT)}; run "pnpm package".`,
    );
  }
  if (typeof receipt.integrity !== 'string' || record.integrity !== receipt.integrity) {
    throw new PackagingError('the verification record is for a different tarball.');
  }
  if (integrityOf(tarball) !== receipt.integrity) {
    throw new PackagingError(`"${tarball}" is not the tarball that was packaged and verified.`);
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readArchiveFile(tarball, 'package/package.json').toString('utf8'));
  } catch (error) {
    if (error instanceof PackagingError) throw error;
    throw new PackagingError('the packaged manifest is not valid JSON.');
  }
  return { tarball, manifest: checkReleaseManifest(manifestValue, expected) };
};
