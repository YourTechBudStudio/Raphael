/**
 * Golden files: the exact bytes the CLI prints, kept beside the tests that produce them.
 *
 * Every piece of user-facing copy is pinned here so that changing a word is a reviewable diff rather
 * than something a loose regular expression lets through. A normal run compares and fails with a line
 * diff; `RAPHAEL_UPDATE_GOLDEN=1` rewrites the files from what the CLI prints now, and the diff is
 * then reviewed like any other change.
 *
 * Each surface owns one directory and checks, after its cases have run, that no file in it was left
 * without a case. A golden file nobody compares against is a promise nothing keeps.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Ran } from './cli.ts';

const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'golden');

export const UPDATING = process.env.RAPHAEL_UPDATE_GOLDEN === '1';

/**
 * One case per file: exit code, then stdout, then stderr, each verbatim under a fixed header. The
 * streams are written exactly as printed, so a missing or extra trailing newline shows up as a change.
 */
export const formatRan = (ran: Ran): string =>
  `==== exit ====\n${ran.code}\n==== stdout ====\n${ran.stdout}==== stderr ====\n${ran.stderr}`;

export interface GoldenSurface {
  /** Compare a whole run with `<surface>/<name>.golden`. */
  readonly expectRun: (name: string, ran: Ran) => void;
  /** Compare a sentence that is not printed by a run with `<surface>/<name>.txt`. */
  readonly expectText: (name: string, text: string) => void;
  /** Golden files in this surface that no case compared against. Removed instead when updating. */
  readonly strays: () => readonly string[];
}

export const goldenSurface = (surface: string): GoldenSurface => {
  const directory = join(GOLDEN_ROOT, surface);
  const checked = new Set<string>();

  const compare = (file: string, actual: string): void => {
    if (checked.has(file)) throw new Error(`Two cases share the golden file ${surface}/${file}.`);
    checked.add(file);
    const path = join(directory, file);
    if (UPDATING) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, actual);
      return;
    }
    assert.ok(
      existsSync(path),
      `No golden file at ${surface}/${file}. Run with RAPHAEL_UPDATE_GOLDEN=1 to create it.`,
    );
    assert.equal(actual, readFileSync(path, 'utf8'), `${surface}/${file} differs`);
  };

  return {
    expectRun: (name, ran) => compare(`${name}.golden`, formatRan(ran)),
    expectText: (name, text) => compare(`${name}.txt`, `${text}\n`),
    strays: () => {
      if (!existsSync(directory)) return [];
      const unused = readdirSync(directory).filter((file) => !checked.has(file));
      if (UPDATING) {
        for (const file of unused) rmSync(join(directory, file));
        return [];
      }
      return unused;
    },
  };
};

/**
 * A refusal: nothing on stdout, exactly these lines on stderr, and this exit code.
 *
 * Exact lines rather than a pattern, so a refusal cannot quietly regress to raw parser or decoder
 * text while a fragment of the old wording still matches. Phase 02 extends this to the JSON error
 * document.
 */
export const assertRefusal = (
  ran: Ran,
  expected: { readonly exit: number; readonly lines: readonly string[] },
): void => {
  assert.equal(ran.stdout, '', 'a refusal prints nothing on stdout');
  assert.equal(ran.stderr, `${expected.lines.join('\n')}\n`);
  assert.equal(ran.code, expected.exit);
};

/** A file-name-safe slug for a case label. */
export const caseName = (...parts: readonly string[]): string =>
  parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
