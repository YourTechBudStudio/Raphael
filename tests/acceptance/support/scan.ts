/**
 * Searching the source tree, in this process.
 *
 * This began as a `grep` child process and should not have. A scan-based gate has exactly one
 * catastrophic failure mode - reporting absence because the scan never ran - and a subprocess offers
 * several routes to it: a failure to spawn, a usage error, a timeout, a directory that is not there.
 * Checking the exit status is not enough to close them, and on this machine that is not a theoretical
 * point: the `grep` on PATH is ugrep, which reports a missing directory as a *warning* and exits 1,
 * which is byte-for-byte indistinguishable from "no matches found". `/usr/bin/grep` answers 1 as well.
 * A gate whose meaning depends on which grep is installed is not a gate.
 *
 * Reading the files here removes the whole class. There is no PATH, no exit convention, and no
 * platform variation; a directory that does not exist throws while being read, which is the correct
 * outcome and needs no interpretation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const SEARCHED = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx']);

/** Directories that are never product source, and would only add noise and time. */
const SKIPPED = new Set(['node_modules', 'dist', '.expo', 'coverage', 'build', 'out']);

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const filesUnder = (directory: string, found: string[]): string[] => {
  // `withFileTypes` so a symbolic link is not silently followed into another tree.
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED.has(entry.name)) continue;
      filesUnder(join(directory, entry.name), found);
      continue;
    }
    if (entry.isFile() && SEARCHED.has(extname(entry.name))) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
};

/**
 * Every occurrence of `needle` under these roots, as repository-relative `file:line` hits.
 *
 * A root that cannot be read throws rather than contributing nothing, and a search that matches
 * nothing returns an empty array. Those two outcomes are now genuinely different, which is the entire
 * point of this module.
 */
export const scanFor = (
  needle: string,
  roots: readonly string[],
  repositoryRoot: string,
): readonly Hit[] => {
  const hits: Hit[] = [];
  for (const root of roots) {
    for (const file of filesUnder(root, [])) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        if (text.includes(needle)) {
          hits.push({ file: relative(repositoryRoot, file), line: index + 1, text: text.trim() });
        }
      });
    }
  }
  return hits;
};
