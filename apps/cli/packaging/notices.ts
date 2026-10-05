/**
 * License texts for the third-party code the package actually distributes.
 *
 * The distributed set is what the bundler reports it read from `node_modules`, plus the vendored
 * SQLite loader - not every development dependency. For each package the full license and notice
 * files it ships are reproduced; a declared SPDX identifier alone is not a license text. A package
 * published without its license file is listed in `RECORDED_LICENSES` with the upstream file for that
 * exact release, kept beside this module and checked by digest, so an upgrade is reviewed again.
 * Anything else without a text stops packaging: nothing is substituted and no copyright line is made
 * up.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { PackagingError } from './errors.ts';

export interface DistributedPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly root: string;
}

/** An upstream license file for a release whose npm package omits it. */
export interface RecordedLicense {
  /** Relative to this module. */
  readonly file: string;
  /** Where the file was taken from, exactly. */
  readonly origin: string;
  readonly sha256: string;
}

export const RECORDED_LICENSES: Readonly<Record<string, RecordedLicense>> = {
  'drizzle-orm@0.45.2': {
    file: 'licenses/drizzle-orm-0.45.2-LICENSE',
    origin:
      'https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/LICENSE (tag 0.45.2, commit 273c78071d4841b497f5144734b38294df7ec64b)',
    sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  },
};

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i;
const MODULES = `${sep}node_modules${sep}`;

/** The package directory containing `file`, if `file` came from an installed dependency. */
export const packageRootOf = (file: string): string | undefined => {
  const at = file.lastIndexOf(MODULES);
  if (at === -1) return undefined;
  const rest = file.slice(at + MODULES.length).split(sep);
  const depth = rest[0]?.startsWith('@') === true ? 2 : 1;
  if (rest.length <= depth) return undefined;
  return file.slice(0, at + MODULES.length) + rest.slice(0, depth).join(sep);
};

export const describePackage = (root: string): DistributedPackage => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly license?: unknown;
  };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new PackagingError(`"${join(root, 'package.json')}" has no name or version.`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'UNDECLARED',
    root,
  };
};

/** The distinct installed packages among absolute input paths, sorted by name and version. */
export const distributedPackages = (files: Iterable<string>): DistributedPackage[] => {
  const roots = new Set<string>();
  for (const file of files) {
    const root = packageRootOf(file);
    if (root !== undefined) roots.add(root);
  }
  const byId = new Map<string, DistributedPackage>();
  for (const root of roots) {
    const described = describePackage(root);
    byId.set(`${described.name}@${described.version}`, described);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
};

const recordedText = (id: string, recorded: RecordedLicense): string => {
  const content = readFileSync(new URL(recorded.file, import.meta.url));
  if (createHash('sha256').update(content).digest('hex') !== recorded.sha256) {
    throw new PackagingError(`the recorded license for ${id} does not match its digest.`);
  }
  return `(Not included in the npm package; from ${recorded.origin}.)\n\n${content.toString('utf8').trim()}`;
};

const textsOf = (
  pkg: DistributedPackage,
  recorded: Readonly<Record<string, RecordedLicense>>,
): string[] => {
  const files = readdirSync(pkg.root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length > 0) {
    return files.map((file) => readFileSync(join(pkg.root, file), 'utf8').trim());
  }
  const id = `${pkg.name}@${pkg.version}`;
  const entry = recorded[id];
  return entry === undefined ? [] : [recordedText(id, entry)];
};

/** The notices file's content. Fails, naming every package concerned, if any text is missing. */
export const renderNotices = (
  packages: readonly DistributedPackage[],
  recorded: Readonly<Record<string, RecordedLicense>> = RECORDED_LICENSES,
): string => {
  const missing: string[] = [];
  const sections = packages.map((pkg) => {
    const texts = textsOf(pkg, recorded);
    if (texts.length === 0) missing.push(`${pkg.name}@${pkg.version} (${pkg.license})`);
    return [`${pkg.name}@${pkg.version}`, `License: ${pkg.license}`, '', ...texts].join('\n');
  });
  if (missing.length > 0) {
    throw new PackagingError(
      `no license text was found for these distributed packages:\n  ${missing.join('\n  ')}`,
    );
  }
  const rule = `\n\n${'-'.repeat(78)}\n\n`;
  return `Third-party software distributed in this package, with its license texts.${rule}${sections.join(rule)}\n`;
};
