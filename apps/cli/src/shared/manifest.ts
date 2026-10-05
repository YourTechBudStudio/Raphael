import { readFileSync } from 'node:fs';

/**
 * The `version` field of a manifest, validated. There is no fallback: a copy whose manifest cannot be
 * read is broken, and saying "0.0.0" would hide that behind a plausible number.
 */
export const readManifestVersion = (manifestUrl: URL): string => {
  const manifest: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('package manifest has no version field.');
  }
  const { version: value } = manifest as { readonly version: unknown };
  if (typeof value !== 'string' || value === '') {
    throw new Error('package manifest version is not a string.');
  }
  return value;
};
