/**
 * Copying into, and inspecting, the staged package.
 *
 * Only regular files and directories are accepted, in both directions. A symbolic link in a source -
 * the file itself, or any directory between it and its trusted root - would copy whatever it happened
 * to point at on the packaging machine; one in the stage would ship a link that resolves differently,
 * or not at all, after installation. Resolving pnpm's link to an installed dependency is the caller's
 * deliberate step, done once before the resolved directory is handed over as a root.
 */

import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { PackagingError } from './errors.ts';

/** Whether `path` is `root` itself or lies beneath it, compared lexically after resolution. */
export const isWithin = (root: string, path: string): boolean => {
  const offset = relative(root, path);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
};

const requireRegularFile = (path: string): void => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new PackagingError(`required file "${path}" is missing.`);
  }
  if (!stats.isFile()) {
    throw new PackagingError(`"${path}" is not a regular file.`);
  }
};

const requireRealDirectory = (root: string): void => {
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    throw new PackagingError(`required directory "${root}" is missing.`);
  }
  if (!stats.isDirectory()) {
    throw new PackagingError(`"${root}" is not a directory.`);
  }
};

/** Copies `root/file` to `target`, refusing a symbolic link at the root, the file, or anywhere between. */
export const copyRegularFile = (root: string, file: string, target: string): void => {
  requireRealDirectory(root);
  const source = join(root, file);
  requireRegularFile(source);
  if (realpathSync(source) !== join(realpathSync(root), file)) {
    throw new PackagingError(`"${source}" passes through a symbolic link.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
};

/**
 * Every regular file under `root`, as `/`-separated paths relative to it, sorted. Anything that is
 * not a regular file or directory, or that would resolve outside `root`, is refused.
 */
export const listFiles = (root: string): string[] => {
  requireRealDirectory(root);
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!isWithin(root, path)) {
        throw new PackagingError(`"${path}" escapes "${root}".`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join('/'));
      else throw new PackagingError(`"${path}" is not a regular file or directory.`);
    }
  };
  visit(root);
  return found.sort();
};
