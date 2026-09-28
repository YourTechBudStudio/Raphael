/**
 * Every sentence the phone says about archive and restore, and the one sentence for any plain action
 * that failed.
 *
 * One file, because the same fact is described on container screens, on the edit screen and in
 * search. Wording follows the resulting state, never the verb alone: a restore can leave something
 * archived through a container above it.
 */

import type { ClientFailure } from '@raphael/client';
import {
  DIRECT_ARCHIVE_REASON,
  USER_ARCHIVE_OWNER,
  type ArchiveCause,
  type NodeType,
} from '@raphael/contracts/nodes';

import type { LifecycleView } from './view.ts';

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
 * The quiet line under a container's toggles, in two parts: the words, and the origin's name when it
 * names a container, which the screen draws as the part that opens it. Null when the filled toggle
 * already says it all.
 *
 * An inherited cause is named first, even beside the user's own: restoring your own cause leaves the
 * screen archived, and this is the line that says why.
 */
export const inheritedLineParts = (
  view: LifecycleView,
): { readonly lead: string; readonly origin: string | null } | null => {
  const inherited = view.nearestInherited;

  if (inherited !== null) {
    return {
      lead: view.canRestore ? 'Also archived with ' : 'Archived with ',
      origin: originName(inherited),
    };
  }

  const foreign = foreignOwnCause(view);

  return foreign === null ? null : { lead: `Archived by ${foreign.owner}`, origin: null };
};

/** The same line as one sentence, for its spoken label. */
export const inheritedLine = (view: LifecycleView): string | null => {
  const parts = inheritedLineParts(view);

  return parts === null ? null : `${parts.lead}${parts.origin ?? ''}`;
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
 * One sentence for a plain action that failed - favorite, archive, restore, move - said in the
 * snackbar or under the toggle: "Couldn’t archive. Can’t reach your server."
 */
export const failedActionSentence = (action: string, failure: ClientFailure | null): string =>
  `${action}. ${failureReason(failure)}`;

const failureReason = (failure: ClientFailure | null): string => {
  if (failure === null) return 'Try again.';
  if (failure.kind === 'network' || failure.kind === 'timeout') return 'Can’t reach your server.';
  if (failure.code === 'revision_conflict') return 'It changed on your server, try again.';
  if (failure.kind === 'http' && (failure.status ?? 0) >= 500) {
    return 'Your server had a problem, try again.';
  }

  return failure.message;
};
