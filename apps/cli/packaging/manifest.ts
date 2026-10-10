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

export const RELEASE_NAME = '@yourtechbudstudio/raphael';
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
export const SEMVER =
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

/** A manifest's version - the root's, unless said otherwise - refused unless it is exactly a semantic version. It is never adjusted. */
export const releaseVersion = (manifest: unknown, owner = 'the root'): string => {
  const version = text(record(manifest, `${owner} manifest`).version, `${owner} "version"`);
  if (!SEMVER.test(version)) {
    throw new PackagingError(
      `${owner} "version" ${JSON.stringify(version)} is not a semantic version.`,
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
  const name = text(cli.name, 'the CLI "name"');
  if (name !== RELEASE_NAME) {
    throw new PackagingError(`the CLI "name" must be ${JSON.stringify(RELEASE_NAME)}.`);
  }
  return {
    name,
    version: releaseVersion(root),
    private: false,
    description: text(root.description, 'the root "description"'),
    author: text(root.author, 'the root "author"'),
    type: 'module',
    bin: { [BIN_NAME]: BIN_PATH },
    files: ['dist', NOTICES_FILE],
    engines: { node: releaseEngines(root) },
    publishConfig: { access: 'public' },
  };
};

/** The root's Node requirement, which the release manifest must carry unchanged. */
export const releaseEngines = (rootManifest: unknown): string =>
  text(
    record(record(rootManifest, 'the root manifest').engines, 'the root "engines"').node,
    'the root "engines.node"',
  );

const MANIFEST_FIELDS: readonly (keyof ReleaseManifest)[] = [
  'name',
  'version',
  'private',
  'description',
  'author',
  'type',
  'bin',
  'files',
  'engines',
  'publishConfig',
];

/**
 * A manifest read back out of a tarball, checked against the contract `releaseManifest` produces.
 *
 * This is what makes "the artifact" a checkable claim for anything that only has the tarball: the
 * verifier on another machine, and the publishing helper. Any field beyond the generated ones is
 * refused, which is what keeps dependency declarations and lifecycle scripts out; they are also named
 * explicitly so that the refusal says why. `expected` pins what the caller already knows: the
 * repository supplies its root version and engines, a standalone verification may supply a version.
 */
export const checkReleaseManifest = (
  value: unknown,
  expected: { readonly version?: string; readonly engines?: string } = {},
): ReleaseManifest => {
  const manifest = record(value, 'the packaged manifest');
  for (const forbidden of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
    'scripts',
  ]) {
    if (forbidden in manifest) {
      throw new PackagingError(`the packaged manifest declares "${forbidden}".`);
    }
  }
  const unexpected = Object.keys(manifest).filter(
    (key) => !(MANIFEST_FIELDS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw new PackagingError(
      `the packaged manifest has unexpected fields: ${unexpected.join(', ')}.`,
    );
  }
  if (manifest.name !== RELEASE_NAME) {
    throw new PackagingError(
      `the packaged name is ${JSON.stringify(manifest.name)}, not ${JSON.stringify(RELEASE_NAME)}.`,
    );
  }
  const version = releaseVersion(manifest, 'the packaged');
  if (expected.version !== undefined && version !== expected.version) {
    throw new PackagingError(
      `the packaged version ${JSON.stringify(version)} is not the expected ${JSON.stringify(expected.version)}.`,
    );
  }
  const exact = (field: keyof ReleaseManifest, wanted: unknown): void => {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(wanted)) {
      throw new PackagingError(
        `the packaged "${field}" is ${JSON.stringify(manifest[field])}, not ${JSON.stringify(wanted)}.`,
      );
    }
  };
  exact('private', false);
  exact('type', 'module');
  exact('bin', { [BIN_NAME]: BIN_PATH });
  exact('files', ['dist', NOTICES_FILE]);
  exact('publishConfig', { access: 'public' });
  const engines = text(
    record(manifest.engines, 'the packaged "engines"').node,
    'the packaged "engines.node"',
  );
  exact('engines', { node: expected.engines ?? engines });
  text(manifest.description, 'the packaged "description"');
  text(manifest.author, 'the packaged "author"');
  return manifest as unknown as ReleaseManifest;
};
