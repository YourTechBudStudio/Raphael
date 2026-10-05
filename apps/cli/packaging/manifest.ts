/**
 * The published package's manifest, generated rather than copied.
 *
 * The source CLI manifest describes a workspace member: private, with workspace dependencies, source
 * exports, and development scripts. None of that is true of the artifact, so nothing is serialized
 * from it except its identity. The version and the Node requirement come from the repository root,
 * which is the only release-version authority. The artifact carries its whole runtime, so the manifest
 * declares no dependencies and no lifecycle scripts for npm to act on.
 */

import { PackagingError } from './errors.ts';

export const BIN_NAME = 'raphael';
export const BIN_PATH = 'dist/main.js';
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

export interface ReleaseManifest {
  readonly name: string;
  readonly version: string;
  readonly private: false;
  readonly description: string;
  readonly author: string;
  readonly type: 'module';
  readonly bin: { readonly [BIN_NAME]: string };
  readonly files: readonly string[];
  readonly engines: { readonly node: string };
  readonly publishConfig: { readonly access: 'public' };
}

/** Semantic Versioning 2.0.0, as published at semver.org. npm rejects anything else. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const record = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PackagingError(`${label} is not a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PackagingError(`${label} must be a nonempty string.`);
  }
  return value;
};

/** The root version, refused unless it is exactly a semantic version. It is never adjusted. */
export const releaseVersion = (rootManifest: unknown): string => {
  const version = text(record(rootManifest, 'the root manifest').version, 'the root "version"');
  if (!SEMVER.test(version)) {
    throw new PackagingError(
      `the root "version" ${JSON.stringify(version)} is not a semantic version.`,
    );
  }
  return version;
};

export const releaseManifest = (rootManifest: unknown, cliManifest: unknown): ReleaseManifest => {
  const root = record(rootManifest, 'the root manifest');
  const cli = record(cliManifest, 'the CLI manifest');
  // The source stays private so that the unbundled workspace package can never be published by
  // accident. A source manifest that has lost that guard is a mistake to fix, not to package around.
  if (cli.private !== true) {
    throw new PackagingError('the CLI source manifest must stay "private": true.');
  }
  const sourceBin = record(cli.bin, 'the CLI "bin"');
  if (!(BIN_NAME in sourceBin)) {
    throw new PackagingError(`the CLI "bin" does not declare "${BIN_NAME}".`);
  }
  return {
    name: text(cli.name, 'the CLI "name"'),
    version: releaseVersion(root),
    private: false,
    description: text(root.description, 'the root "description"'),
    author: text(root.author, 'the root "author"'),
    type: 'module',
    bin: { [BIN_NAME]: BIN_PATH },
    files: ['dist', NOTICES_FILE],
    engines: {
      node: text(record(root.engines, 'the root "engines"').node, 'the root "engines.node"'),
    },
    publishConfig: { access: 'public' },
  };
};
