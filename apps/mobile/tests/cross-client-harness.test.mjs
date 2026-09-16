/**
 * The integration harness cleans up after itself without cleaning up after anyone else.
 *
 * `node --test` runs test files concurrently in separate processes, and the cross-client suites all
 * keep their scratch state under the repository's git-ignored `data/`. Anything above a process's
 * own root is therefore genuine shared state on disk, and "remove what I made" has to mean this
 * process's own tree and nothing else. Two distinct races are possible there, and both have been
 * live in this helper:
 *
 *   1. Removing a shared parent **recursively**, which deletes databases other suites are still
 *      running against.
 *   2. Removing a shared parent **at all**, even when empty: taking a root is `mkdir` followed by
 *      `mkdtemp`, and a worker that finishes between those two calls can delete the directory the
 *      starting worker is about to create its root in, leaving it to fail with `ENOENT`.
 *
 * The second is why the helper now creates owned roots directly beneath `data/` - a directory that
 * pre-exists and that nothing here ever removes - rather than beneath a per-run parent of its own.
 *
 * These properties are invisible from the suites that depend on them: they pass either way, and
 * only timing decides. So they are asserted directly here instead.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { cleanupDirectories, RUNTIME_PARENT, temporaryDir } from './support/cross-client.mjs';

const exists = async (target) => {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
};

describe('the cross-client harness cleanup', () => {
  it('removes what this process owns and leaves a concurrent worker untouched', async () => {
    // A directory this process owns, holding something worth losing.
    const mine = await temporaryDir('mine-');
    const myFile = path.join(mine, 'database.sqlite');
    await writeFile(myFile, 'mine', 'utf8');

    // Another worker's root, created the way the helper creates one, holding a database it is
    // still using. Nothing about this process owns it.
    await mkdir(RUNTIME_PARENT, { recursive: true });
    const sibling = await mkdtemp(path.join(RUNTIME_PARENT, 'phase-07-runtime-'));
    const siblingFile = path.join(sibling, 'database.sqlite');
    await writeFile(siblingFile, 'still in use', 'utf8');

    try {
      await cleanupDirectories();

      assert.equal(await exists(myFile), false, 'this process removed its own state');
      assert.equal(
        await exists(siblingFile),
        true,
        "a concurrent worker's database survived this process finishing",
      );
      assert.equal(await readFile(siblingFile, 'utf8'), 'still in use', 'and was not truncated');
    } finally {
      await rm(sibling, { recursive: true, force: true });
      await cleanupDirectories();
    }
  });

  it('leaves the parent directory alone, so a worker mid-initialization cannot lose it', async () => {
    // The interleaving that an empty-parent `rmdir` could not survive. A starting worker has got as
    // far as ensuring the parent exists and has not yet taken its own root; a finishing worker then
    // completes its entire cleanup; the starting worker takes its root afterwards.
    await temporaryDir('mine-');

    await mkdir(RUNTIME_PARENT, { recursive: true }); // starting worker, step one
    await cleanupDirectories(); // finishing worker, in full

    assert.equal(
      await exists(RUNTIME_PARENT),
      true,
      'the directory the starting worker is about to use is still there',
    );

    // Starting worker, step two. Under a shape that removed the parent this throws ENOENT.
    const late = await mkdtemp(path.join(RUNTIME_PARENT, 'phase-07-runtime-'));

    try {
      await writeFile(path.join(late, 'database.sqlite'), 'started late', 'utf8');
      assert.equal(await exists(path.join(late, 'database.sqlite')), true, 'and it is usable');
    } finally {
      await rm(late, { recursive: true, force: true });
    }
  });

  it('hands out directories again after a cleanup, rather than reusing a removed root', async () => {
    const first = await temporaryDir('first-');
    await cleanupDirectories();

    const second = await temporaryDir('second-');
    await writeFile(path.join(second, 'probe'), 'ok', 'utf8');

    try {
      assert.notEqual(second, first, 'a new root, not the one that was just removed');
      assert.equal(await exists(path.join(second, 'probe')), true, 'and it is usable');
    } finally {
      await cleanupDirectories();
    }
  });
});
