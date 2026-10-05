/**
 * The backend's migrations, staged beside the bundle.
 *
 * Drizzle's migrator reads `meta/_journal.json` and one `<tag>.sql` per journal entry; nothing else in
 * the folder is consulted at runtime, so exactly that is shipped. Every journalled migration must be
 * present - a package missing one would refuse, or worse half-apply, an existing database.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PackagingError } from './errors.ts';
import { copyRegularFile } from './files.ts';

const JOURNAL = join('meta', '_journal.json');
const TAG = /^[A-Za-z0-9_-]+$/;

const journalTags = (sourceFolder: string): string[] => {
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(join(sourceFolder, JOURNAL), 'utf8'));
  } catch {
    throw new PackagingError(
      `the migration journal "${join(sourceFolder, JOURNAL)}" is missing or unreadable.`,
    );
  }
  const entries = (journal as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new PackagingError('the migration journal has no entries.');
  }
  return entries.map((entry: unknown) => {
    const tag = (entry as { tag?: unknown }).tag;
    if (typeof tag !== 'string' || !TAG.test(tag)) {
      throw new PackagingError(`the migration journal has an invalid tag ${JSON.stringify(tag)}.`);
    }
    return tag;
  });
};

/** Copies the journal and every migration it names. Returns the staged paths, relative to `targetFolder`. */
export const stageMigrations = (sourceFolder: string, targetFolder: string): string[] => {
  const files = [JOURNAL, ...journalTags(sourceFolder).map((tag) => `${tag}.sql`)];
  for (const file of files) copyRegularFile(sourceFolder, file, join(targetFolder, file));
  return files;
};
