/**
 * Filesystem trust: the checks that decide whether a path on this machine can hold something private.
 *
 * Two callers need exactly the same answer to that question and must not drift apart. The backend
 * protects a SQLite database and the write-ahead log beside it, which hold note content. The CLI
 * protects a configuration file holding a full-access API key. A permission rule that is right in one
 * place and stale in the other is worse than either rule alone, so the rule lives once, here.
 *
 * **What this establishes.** Under the POSIX permission model, no *other unprivileged user* can read a
 * protected artifact, and none can replace the directory entries leading to it. **What it does not
 * establish:** isolation from another process running as the same user, from a privileged
 * administrator, or anything at all about ACLs, mount options, or network filesystems. Those are
 * outside the model, not gaps that further mode checks would close.
 *
 * **What this module deliberately does not do.** It never creates, repairs, chmods, or deletes
 * anything. It answers questions and returns rejections as values. Directory modes, creation policy,
 * and the wording an operator reads all belong to the caller, because they genuinely differ: a
 * database directory may be traversable by others while its files are not, and a credential directory
 * may not. Those are two policies built from one set of facts, not one configurable security
 * framework with a flag.
 */

import { statSync, type Stats } from 'node:fs';
import { dirname, parse as parsePath } from 'node:path';

/** Why a path cannot be trusted. Callers choose the wording; this names the fact. */
export type PathRejectionReason =
  /** An ancestor could not be inspected at all, so nothing about it can be established. */
  | 'ancestor_unreadable'
  /** An ancestor is owned by someone who could change its permissions whenever they liked. */
  | 'ancestor_untrusted_owner'
  /** An ancestor is group- or world-writable, so another user could replace what is beneath it. */
  | 'ancestor_writable'
  /** The artifact itself is a symbolic link. */
  | 'symlink_rejected'
  /** The artifact itself is not a regular file. */
  | 'not_regular_file'
  /** The artifact is owned by someone other than this process's user. */
  | 'foreign_owner'
  /** The artifact is readable or writable by other users. */
  | 'permissive_mode';

export interface PathRejection {
  readonly reason: PathRejectionReason;
  /** The path the rejection is about - an ancestor, or the artifact itself. */
  readonly path: string;
  /** The owning user, for the ownership reasons. */
  readonly uid?: number;
  /** The permission bits (`mode & 0o7777`), for the permission reasons. */
  readonly mode?: number;
}

/**
 * POSIX mode support. On platforms without it these checks establish nothing, and a caller that
 * persists a secret must refuse rather than report protection it cannot provide.
 */
export const supportsPosixModes = (): boolean => process.platform !== 'win32';

export const isGroupOrWorldWritable = (mode: number): boolean => (mode & 0o022) !== 0;

/** Any access at all by group or others: the rule for a directory or file holding a secret. */
export const isGroupOrWorldAccessible = (mode: number): boolean => (mode & 0o077) !== 0;

const isSticky = (mode: number): boolean => (mode & 0o1000) !== 0;

/**
 * A trusted owner is the effective user or root.
 *
 * Ownership matters more than the current mode: an untrusted owner can change the permissions of a
 * directory whenever it likes, so a directory that merely looks restrictive today is not a protection
 * if someone else owns it.
 */
export const isTrustedOwner = (uid: number): boolean => uid === process.getuid?.() || uid === 0;

/**
 * Walk the ancestor chain of an already-resolved directory and report the first untrustworthy link.
 *
 * A directory is acceptable when a trusted user owns it and it is not group- or world-writable. An
 * ordinary `0755` ancestor passes: others being able to read and traverse it is normal, and the
 * artifacts beneath are protected by their own modes. What is refused is an ancestor another user
 * could *replace*, because then no mode on the artifact matters.
 *
 * The sticky bit is deliberately not treated as sufficient on its own: it restricts removal to the
 * entry's owner, the directory's owner, and privileged users, which still leaves an untrusted
 * directory owner able to replace entries. Shared ancestors such as `/tmp` pass this check because
 * root owns them, not because they are sticky.
 *
 * Pass a path that has already been resolved through `realpathSync`. Verifying one chain and then
 * writing through a different, unchecked alias would reopen exactly the substitution problem this
 * walk exists to close.
 */
export const inspectAncestors = (resolvedDirectory: string): PathRejection | undefined => {
  const { root } = parsePath(resolvedDirectory);
  let current = resolvedDirectory;
  for (;;) {
    let info: Stats;
    try {
      info = statSync(current);
    } catch {
      return { reason: 'ancestor_unreadable', path: current };
    }
    if (!isTrustedOwner(info.uid)) {
      return { reason: 'ancestor_untrusted_owner', path: current, uid: info.uid };
    }
    if (isGroupOrWorldWritable(info.mode) && !isSticky(info.mode)) {
      return { reason: 'ancestor_writable', path: current, mode: info.mode & 0o7777 };
    }
    if (current === root) return undefined;
    const next = dirname(current);
    if (next === current) return undefined;
    current = next;
  }
};

/**
 * Check an artifact that already exists and must be private: a regular file, owned by this process's
 * user, with no access by group or others.
 *
 * Takes the `lstat` result rather than reading it again, so the decision is made about the entry the
 * caller actually looked at. A symbolic link is refused outright rather than followed - Raphael does
 * not adopt storage or credentials through a link it did not place.
 */
export const inspectProtectedFile = (path: string, info: Stats): PathRejection | undefined => {
  if (info.isSymbolicLink()) return { reason: 'symlink_rejected', path };
  if (!info.isFile()) return { reason: 'not_regular_file', path };
  if (info.uid !== process.getuid?.()) {
    return { reason: 'foreign_owner', path, uid: info.uid };
  }
  if (isGroupOrWorldAccessible(info.mode)) {
    return { reason: 'permissive_mode', path, mode: info.mode & 0o7777 };
  }
  return undefined;
};

/** Permission bits as an operator would type them into `chmod`. */
export const formatMode = (mode: number): string => (mode & 0o7777).toString(8);
