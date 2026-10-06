/**
 * The tarball, made by npm and then read back.
 *
 * npm decides what goes into a package (its own inclusions and exclusions on top of `files`), so the
 * archive is inspected directly rather than trusted: it must hold exactly the staged files, as regular
 * entries, with the bin executable. npm's JSON listing does not carry file modes, which is why the
 * headers are read here.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { PackagingError } from './errors.ts';

export interface PackResult {
  readonly filename: string;
  readonly integrity: string;
  readonly shasum: string;
  readonly size: number;
}

export interface ArchiveEntry {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
}

/** Runs `npm pack` on the stage with lifecycle scripts disabled and returns what npm reported. */
export const pack = (stageDir: string, destination: string): PackResult => {
  const ran = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: stageDir, encoding: 'utf8' },
  );
  if (ran.status !== 0) {
    throw new PackagingError(`npm pack failed (${String(ran.status)}):\n${ran.stderr}`);
  }
  let reported: unknown;
  try {
    reported = JSON.parse(ran.stdout);
  } catch {
    throw new PackagingError(`npm pack did not report JSON:\n${ran.stdout}`);
  }
  if (!Array.isArray(reported) || reported.length !== 1) {
    throw new PackagingError('npm pack reported an unexpected number of packages.');
  }
  const result = reported[0] as Partial<Record<keyof PackResult, unknown>>;
  if (
    typeof result.filename !== 'string' ||
    result.filename.includes('/') ||
    typeof result.integrity !== 'string' ||
    typeof result.shasum !== 'string' ||
    typeof result.size !== 'number'
  ) {
    throw new PackagingError('npm pack reported an incomplete result.');
  }
  return {
    filename: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
    size: result.size,
  };
};

const field = (header: Buffer, start: number, length: number): string =>
  header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');

const octal = (header: Buffer, start: number, length: number): number =>
  Number.parseInt(field(header, start, length).trim() || '0', 8);

/** Walks a gzipped ustar archive, handing each regular file to `visit`. Anything else is refused. */
const walkArchive = (tarball: string, visit: (entry: ArchiveEntry, body: Buffer) => void): void => {
  const data = gunzipSync(readFileSync(tarball));
  let longPath: string | undefined;
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = field(header, 156, 1);
    const body = offset + 512;
    offset = body + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      // A pax extended header; only a long path is meaningful for these entries.
      const records = data.subarray(body, body + size).toString('utf8');
      longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records)?.[1];
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = longPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    longPath = undefined;
    if (type !== '0' && type !== '') {
      throw new PackagingError(`the archive entry "${path}" is not a regular file.`);
    }
    visit({ path, mode: octal(header, 100, 8), size }, data.subarray(body, body + size));
  }
};

/** The entries of a gzipped ustar archive. Only regular files are accepted. */
export const readArchive = (tarball: string): ArchiveEntry[] => {
  const entries: ArchiveEntry[] = [];
  walkArchive(tarball, (entry) => entries.push(entry));
  return entries;
};

/** The contents of one archive member, which must appear exactly once. */
export const readArchiveFile = (tarball: string, path: string): Buffer => {
  const found: Buffer[] = [];
  walkArchive(tarball, (entry, body) => {
    if (entry.path === path) found.push(Buffer.from(body));
  });
  if (found.length !== 1) {
    throw new PackagingError(
      `the archive holds ${String(found.length)} copies of "${path}", not exactly one.`,
    );
  }
  return found[0] as Buffer;
};

/** npm's integrity string for a file: `sha512-` and the base64 digest. */
export const integrityOf = (file: string): string =>
  `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

/** The archive must hold exactly the staged files, under npm's `package/` root, with `bin` executable. */
export const checkArchive = (
  entries: readonly ArchiveEntry[],
  stagedFiles: readonly string[],
  binPath: string,
): void => {
  const archived = entries.map((entry) => entry.path).sort();
  const expected = stagedFiles.map((file) => `package/${file}`).sort();
  if (JSON.stringify(archived) !== JSON.stringify(expected)) {
    const extra = archived.filter((path) => !expected.includes(path));
    const missing = expected.filter((path) => !archived.includes(path));
    throw new PackagingError(
      `the archive does not match the stage: extra [${extra.join(', ')}], missing [${missing.join(', ')}].`,
    );
  }
  const bin = entries.find((entry) => entry.path === `package/${binPath}`);
  if (bin === undefined || (bin.mode & 0o111) === 0) {
    throw new PackagingError(`"${binPath}" is not executable in the archive.`);
  }
};
