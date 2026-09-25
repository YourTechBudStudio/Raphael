/**
 * Every sentence the phone says about archive and restore.
 *
 * One file, because the same fact is described on container screens, on the edit screen, in capture
 * and in search, and four separately-written sentences about "why is this archived" is how a product
 * ends up telling someone two different things about one note.
 *
 * Two rules every sentence obeys. **Wording follows the resulting state**, from a response or a
 * re-read, never the verb alone: a restore can leave something archived through a container above
 * it. And **nothing claims a refresh that did not happen**: "refreshed" and "showing" appear only when
 * a read after the request succeeded.
 */

import type { ClientFailure } from '@raphael/client';
import type { RecoveryDetails } from '@raphael/contracts';
import {
  DIRECT_ARCHIVE_REASON,
  USER_ARCHIVE_OWNER,
  type ArchiveCause,
  type NodeType,
} from '@raphael/contracts/nodes';

import { lifecycleView, type LifecycleView } from './view.ts';

export type LifecycleVerb = 'archive' | 'restore';

/** The visible word on the toggle in every state, like "Active" and "Favorite". */
export const ARCHIVE_LABEL = 'Archive';
/** Search's pill. */
export const ARCHIVED_LABEL = 'Archived';
export const INCLUDE_ARCHIVED_LABEL = 'Include archived';
export const INCLUDE_ARCHIVED_HINT = 'Adds archived areas, projects and notes to the results';

/** The Details chip's hint while the entity is archived: it still opens, and changes nothing. */
export const READ_ONLY_DETAILS_HINT = 'Shows the ID and tags. Nothing can change while archived';

/** Shown only when the server says an archived node matched, followed by `INCLUDE_ARCHIVED_LABEL`. */
export const ARCHIVED_LEFT_OUT_SENTENCE = 'Archived matches are left out.';

/** For a control that stays in place, drawn unavailable, because the server would refuse it. */
export const UNAVAILABLE_WHILE_ARCHIVED_HINT = 'Unavailable while this is archived';

const TYPE_WORD: Record<NodeType, string> = {
  area: 'Area',
  project: 'Project',
  resource: 'Note',
};

/** `Area “Work”`: a container named the way every lifecycle sentence names it. */
const originName = (cause: ArchiveCause): string =>
  `${TYPE_WORD[cause.origin.type]} “${cause.origin.title}”`;

/**
 * A cause on the entity itself that is not the user's own archive: another owner's, or another
 * reason. It makes the entity directly archived without the user being able to restore it.
 */
const foreignOwnCause = (view: LifecycleView): ArchiveCause | null =>
  view.causes.find(
    (cause) =>
      cause.origin.id === view.nodeId &&
      !(cause.owner === USER_ARCHIVE_OWNER && cause.reason === DIRECT_ARCHIVE_REASON),
  ) ?? null;

/**
 * The toggle's spoken hint. It says what pressing does, and that nothing is deleted.
 *
 * Restore removes only the user's own cause, so it promises lists and search back only when nothing
 * else keeps the entity archived; otherwise it names what will. Archive on something already archived
 * hides nothing new, so it says what the user's own cause is for.
 */
export const toggleHint = (view: LifecycleView | null): string => {
  if (view === null || view.standing === 'active') {
    return 'Hides it from lists and search. Nothing is deleted';
  }
  if (!view.canRestore) {
    // Already hidden, so pressing adds the user's own cause: what that buys is staying archived.
    return view.nearestInherited === null
      ? 'Adds your own archive, so it stays archived whatever else is removed'
      : `Adds your own archive, so it stays archived when ${originName(view.nearestInherited)} is restored`;
  }

  const inherited = view.nearestInherited;

  if (inherited !== null) {
    return `Removes your archive. It stays archived with ${originName(inherited)}`;
  }

  const foreign = foreignOwnCause(view);

  return foreign === null
    ? 'Brings it back to lists and search'
    : `Removes your archive. It stays archived by ${foreign.owner}`;
};

/**
 * The read-only Details sheet's subtitle: why nothing in it can change, and the way back, which
 * depends on what keeps the entity archived. Only for an archived view.
 */
export const readOnlyDetailsSubtitle = (view: LifecycleView): string => {
  const inherited = view.nearestInherited;
  const foreign = foreignOwnCause(view);

  if (inherited !== null) {
    return view.canRestore
      ? `Archived, so these cannot change. Restore it and ${originName(inherited)} to edit them.`
      : `Archived with ${originName(inherited)}, so these cannot change. Move it somewhere active, or restore that container, to edit them.`;
  }
  if (view.canRestore) {
    return foreign === null
      ? 'Archived, so these cannot change. Restore it to edit them.'
      : `Archived, so these cannot change. Restoring it still leaves it archived by ${foreign.owner}.`;
  }

  return foreign === null
    ? 'Archived, so these cannot change.'
    : `Archived by ${foreign.owner}, so these cannot change.`;
};

/**
 * The edit screen's status while archived and holding writing that is not on the server. The save
 * status is the more consequential fact, so it is what is said, marked as archived.
 */
export const archivedAlongside = (saveStatus: string): string => `Archived · ${saveStatus}`;

/**
 * The container toggle's spoken label. The visible word never changes; the spoken one says what
 * pressing does, because a state toggle's word alone does not.
 */
export const toggleSpokenLabel = (view: LifecycleView, title: string): string =>
  view.canRestore ? `Restore ${title}` : `Archive ${title}`;

/**
 * The edit screen's icon toggle, which has no visible word at all. `noun` is what is being edited,
 * lowercased: "note", "project", "area".
 */
export const iconToggleSpokenLabel = (view: LifecycleView | null, noun: string): string =>
  view?.canRestore === true ? `Restore this ${noun}` : `Archive this ${noun}`;

/**
 * The quiet line under a container's toggles, or null when the filled toggle already says it all.
 *
 * An inherited cause is named first, even beside the user's own: restoring your own cause leaves the
 * screen archived, and this is the line that says why.
 */
export const inheritedLine = (view: LifecycleView): string | null => {
  const inherited = view.nearestInherited;

  if (inherited !== null) {
    return view.canRestore
      ? `Also archived with ${originName(inherited)}`
      : `Archived with ${originName(inherited)}`;
  }

  const foreign = foreignOwnCause(view);

  return foreign === null ? null : `Archived by ${foreign.owner}`;
};

/** The inherited line's spoken hint, when it opens the container it names. */
export const inheritedLineHint = (title: string): string => `Opens ${title}`;

/**
 * The edit screen's status line while read-only or while a request runs, in place of the save status.
 * Null while active and idle, so the ordinary save status stands.
 */
export const statusSentence = (
  view: LifecycleView | null,
  pending: LifecycleVerb | null,
): string | null => {
  if (pending === 'archive') return 'Archiving…';
  if (pending === 'restore') return 'Restoring…';
  if (view === null || view.standing === 'active') return null;
  if (view.nearestInherited !== null) {
    return `Archived with ${originName(view.nearestInherited)} · read only`;
  }
  if (view.canRestore) return 'Archived · read only';

  const foreign = foreignOwnCause(view);

  return foreign === null ? 'Archived · read only' : `Archived by ${foreign.owner} · read only`;
};

/**
 * What an archive or restore that was sent came to, as the edit owner reports it.
 *
 * `reread` means a Get after the request succeeded, so the phone now shows what the server holds.
 */
export type LifecycleResult =
  | { readonly kind: 'done'; readonly archived: boolean; readonly causes: readonly ArchiveCause[] }
  | { readonly kind: 'refused'; readonly failure: ClientFailure; readonly reread: boolean }
  | { readonly kind: 'unconfirmed'; readonly reread: boolean };

/**
 * The edit screen's line after an action, or null when the resulting state says it on its own.
 *
 * A restore that leaves the entity archived is the one success worth a sentence: the toggle empties
 * and the screen stays read-only, and without this that would look like a failure.
 */
export const outcomeSentence = (
  verb: LifecycleVerb,
  outcome: LifecycleResult,
  nodeId: number,
): string | null => {
  switch (outcome.kind) {
    case 'done': {
      if (verb !== 'restore' || !outcome.archived) return null;

      const after = lifecycleView(nodeId, outcome.causes);

      if (after.nearestInherited !== null) {
        return `Still archived with ${originName(after.nearestInherited)}.`;
      }

      const foreign = foreignOwnCause(after);

      return foreign === null ? 'Still archived.' : `Still archived by ${foreign.owner}.`;
    }
    case 'refused': {
      const { failure } = outcome;

      if (failure.kind === 'api_error' && failure.error.code === 'revision_conflict') {
        return outcome.reread
          ? 'This changed since you looked. Refreshed; try again.'
          : 'This changed since you looked, and Raphael could not read it again. Reopen it before trying again.';
      }

      return failure.message;
    }
    case 'unconfirmed':
      return outcome.reread
        ? 'Raphael could not confirm this. Showing what your server holds now.'
        : 'Raphael could not confirm this, or read what your server holds now. What you see may be out of date.';
  }
};

/**
 * A failed, uncertain or unsent action in a few words, for the one case where the status line has to
 * say two things: the record also keeps writing that is not on the server, and that is said after it.
 * Each result stays distinguishable; the full advice is `outcomeSentence`'s.
 */
export const briefOutcome = (
  verb: LifecycleVerb,
  outcome: Exclude<LifecycleResult, { kind: 'done' }> | { readonly kind: 'not_sent' },
): string => {
  const action = verb === 'archive' ? 'Archive' : 'Restore';

  switch (outcome.kind) {
    case 'refused':
      return outcome.failure.kind === 'api_error' &&
        outcome.failure.error.code === 'revision_conflict'
        ? `${action} refused: this changed since you looked`
        : `${action} refused by your server`;
    case 'unconfirmed':
      return `${action} not confirmed`;
    case 'not_sent':
      return `${action} not sent`;
  }
};

/**
 * A container screen's line under its toggles after a failed action. No claim about a refresh: the
 * screen's own query states report how the re-read went. `failed` says the failure's own message.
 */
export const actionFailureSentence = (
  failure: 'conflict' | 'unconfirmed' | 'failed',
  message: string,
): string => {
  switch (failure) {
    case 'conflict':
      return 'This changed since you looked. Check it, then try again.';
    case 'unconfirmed':
      return 'Raphael could not confirm this. Check it before trying again.';
    case 'failed':
      return message;
  }
};

/**
 * A `node_archived` refusal, from the field and reason the server named.
 *
 * The target is advised by reason, because the remedies differ: your own archive is undone by
 * restoring it, while one inherited from above is undone by moving out or restoring that container.
 * A place is simply somewhere else to pick, whichever way it is archived.
 */
export const archivedRefusalSentence = (details: RecoveryDetails): string => {
  if (details.field === 'target') {
    if (details.reason === 'direct') return 'This is archived. Restore it first.';
    if (details.reason === 'inherited') {
      return 'This is archived with a container above it. Move it somewhere active, or restore that container.';
    }
  }
  if (details.field === 'parent' || details.field === 'destination') {
    return 'That place is archived. Pick another.';
  }

  return 'This is archived.';
};
