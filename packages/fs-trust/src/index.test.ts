import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  formatMode,
  inspectAncestors,
  inspectProtectedFile,
  isGroupOrWorldAccessible,
  isGroupOrWorldWritable,
  isTrustedOwner,
  supportsPosixModes,
} from './index.ts';

/**
 * These tests make real directories and real permission bits. Nothing here is mocked, because the
 * thing under test is a claim about the filesystem and a fake filesystem cannot support that claim.
 *
 * `realpathSync` is applied to the temporary root before anything else: on macOS `/tmp` is a symlink
 * to `/private/tmp`, and verifying one chain while the caller later writes through a different alias
 * is precisely the substitution these checks exist to prevent.
 */

const roots: string[] = [];
const makeRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raphael-fs-trust-')));
  roots.push(root);
  return root;
};

after(() => {
  for (const root of roots) {
    // Restore traversal first: a test that removed it would otherwise leave an unremovable tree.
    try {
      chmodSync(root, 0o700);
    } catch {
      /* already gone or already traversable */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const runningAsRoot = process.getuid?.() === 0;

describe('mode predicates', () => {
  it('separates writability from any access at all', () => {
    assert.equal(isGroupOrWorldWritable(0o700), false);
    assert.equal(isGroupOrWorldWritable(0o755), false);
    assert.equal(isGroupOrWorldWritable(0o775), true);
    assert.equal(isGroupOrWorldWritable(0o702), true);

    // The rule that differs between the two callers: a database directory may be traversable by
    // others while a directory holding a credential may not.
    assert.equal(isGroupOrWorldAccessible(0o700), false);
    assert.equal(isGroupOrWorldAccessible(0o755), true);
    assert.equal(isGroupOrWorldAccessible(0o600), false);
    assert.equal(isGroupOrWorldAccessible(0o640), true);
  });

  it('formats permission bits the way chmod spells them', () => {
    assert.equal(formatMode(0o40755), '755');
    assert.equal(formatMode(0o100600), '600');
    assert.equal(formatMode(0o41777), '1777');
  });
});

describe('owner trust', () => {
  it('trusts this process and root, and nobody else', () => {
    const self = process.getuid?.() ?? 0;
    assert.equal(isTrustedOwner(self), true);
    assert.equal(isTrustedOwner(0), true);
    // A uid that is neither. Chosen to be implausible rather than merely unused.
    assert.equal(isTrustedOwner(self === 65_534 ? 65_533 : 65_534), runningAsRoot);
  });

  it('reports whether the POSIX model applies at all', () => {
    assert.equal(supportsPosixModes(), process.platform !== 'win32');
  });
});

describe('ancestor trust', () => {
  it('accepts an ordinary chain, including world-readable ancestors', () => {
    const root = makeRoot();
    const nested = join(root, 'config', 'raphael');
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(join(root, 'config'), 0o755);
    // 0755 is what ~/.config normally is. Refusing it would make the check unusable rather than safe.
    assert.equal(inspectAncestors(nested), undefined);
  });

  it('refuses a chain whose ancestor another user could replace entries in', () => {
    const root = makeRoot();
    const nested = join(root, 'shared', 'raphael');
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    const shared = join(root, 'shared');
    chmodSync(shared, 0o777);

    const rejection = inspectAncestors(nested);
    assert.equal(rejection?.reason, 'ancestor_writable');
    assert.equal(rejection?.path, shared);
    assert.equal(formatMode(rejection?.mode ?? 0), '777');
  });

  it('accepts a world-writable sticky ancestor only because a trusted user owns it', () => {
    // This is the `/tmp` case. The sticky bit is not what makes it acceptable - ownership is - and
    // the check has to agree, or every temporary directory becomes unusable.
    const root = makeRoot();
    const nested = join(root, 'sticky', 'raphael');
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(join(root, 'sticky'), 0o1777);
    assert.equal(inspectAncestors(nested), undefined);
  });

  it(
    'reports an ancestor it cannot inspect rather than assuming it is fine',
    {
      skip: runningAsRoot ? 'root can traverse a 0000 directory' : false,
    },
    () => {
      const root = makeRoot();
      const blocked = join(root, 'blocked');
      const nested = join(blocked, 'raphael');
      mkdirSync(nested, { recursive: true, mode: 0o700 });
      chmodSync(blocked, 0o000);

      const rejection = inspectAncestors(nested);
      assert.equal(rejection?.reason, 'ancestor_unreadable');

      chmodSync(blocked, 0o700);
    },
  );

  it('stops at the filesystem root without looping', () => {
    // The walk terminates on a real chain all the way up. If `dirname` ever stopped shrinking without
    // reaching the parsed root this would hang rather than fail, which is why it is worth asserting.
    const root = makeRoot();
    assert.equal(inspectAncestors(root), undefined);
  });
});

describe('protected artifacts', () => {
  const fileIn = (root: string, name: string, mode: number): string => {
    const path = join(root, name);
    writeFileSync(path, 'x', { mode });
    chmodSync(path, mode);
    return path;
  };

  it('accepts a regular owner-only file', () => {
    const root = makeRoot();
    const path = fileIn(root, 'config.json', 0o600);
    assert.equal(inspectProtectedFile(path, lstatSync(path)), undefined);
  });

  it('refuses a file others can read', () => {
    const root = makeRoot();
    const path = fileIn(root, 'leaky.json', 0o644);
    const rejection = inspectProtectedFile(path, lstatSync(path));
    assert.equal(rejection?.reason, 'permissive_mode');
    assert.equal(formatMode(rejection?.mode ?? 0), '644');
  });

  it('refuses a group-readable file, not only a world-readable one', () => {
    const root = makeRoot();
    const path = fileIn(root, 'group.json', 0o640);
    assert.equal(inspectProtectedFile(path, lstatSync(path))?.reason, 'permissive_mode');
  });

  it('refuses a symbolic link instead of following it', () => {
    const root = makeRoot();
    const target = fileIn(root, 'target.json', 0o600);
    const link = join(root, 'link.json');
    symlinkSync(target, link);
    // The link points at a file that would itself pass. Following it and checking the target is the
    // mistake: the entry is what an attacker controls.
    assert.equal(inspectProtectedFile(link, lstatSync(link))?.reason, 'symlink_rejected');
  });

  it('refuses something that is not a regular file', () => {
    const root = makeRoot();
    const directory = join(root, 'not-a-file');
    mkdirSync(directory, { mode: 0o700 });
    assert.equal(inspectProtectedFile(directory, lstatSync(directory))?.reason, 'not_regular_file');
  });

  it('never repairs what it refuses', () => {
    const root = makeRoot();
    const path = fileIn(root, 'untouched.json', 0o644);
    inspectProtectedFile(path, lstatSync(path));
    assert.equal(formatMode(lstatSync(path).mode), '644');
  });
});
