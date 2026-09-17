/**
 * Every change on this phone that the server has not been given, as something a list can draw.
 *
 * `unfinished.ts` for edits, and pure for the same reason: the ordering and the action sets are
 * testable without a database, and the certainty question stays with the owner. This derives from
 * `standingFor` rather than from state strings, so nothing here forms a second opinion about what a
 * record means.
 *
 * Two rules carry the weight.
 *
 * **Everything is unfinished except a `synced` record.** A settled record is deleted when the editor
 * leaves, so the only synced records are ones with an editor attached right now - and those still
 * belong on the list while they exist, because a person who navigated away mid-save must be able to
 * find what they were doing.
 *
 * **An unusable row is always listed.** A row this build cannot open is the one thing that must never
 * be invisible, so it is listed with `discard` as its only action - by key, without ever being parsed.
 *
 * **Nothing unfinished is drawn on Home as a card.** Home carries one count; Recovery carries this
 * list, transient rows included. There is no `onHome` projection, deliberately.
 */

import type { NodeType } from '@raphael/contracts/nodes';

import type { EditStanding } from './edit-policy.ts';
import {
  editKeyOf,
  type EditProblem,
  type EntityEditRecord,
  type UnusableEdit,
} from './edit-types.ts';

export interface UnfinishedEdit {
  /** Namespaced by its producer, so an edit and a draft numbered the same are different cards. */
  readonly key: string;
  readonly editKey: string;
  readonly nodeId: number;
  /** Null only for a row whose columns could not be read. Never inferred. */
  readonly nodeType: NodeType | null;
  /** Empty when the column could not be read. Empty is also a legitimate title. */
  readonly title: string;
  /** `'unusable'` for a retained row this build cannot open. */
  readonly standing: EditStanding['kind'] | 'unusable';
  readonly problem?: EditProblem | undefined;
  readonly endpoint: string | null;
  readonly scope: 'current' | 'retired';
  readonly activityAt: number;
  readonly actions: readonly ('open' | 'discard')[];
}

/**
 * Most pressing first, with the two ends of the list argued rather than assumed.
 *
 * `unusable` leads because it is the only row nothing will ever resolve on its own. `saving` trails
 * the ordinary states because a request in the air needs no decision from anyone - it is the one row
 * that is actively getting better while it is looked at.
 */
const GROUP = {
  unusable: 0,
  conflicted: 1,
  refused: 2,
  unconfirmed: 3,
  offline: 4,
  pending: 5,
  saving: 6,
  // Present for totality. A synced record is filtered out above, except while an editor holds it.
  synced: 7,
} as const satisfies Record<EditStanding['kind'] | 'unusable', number>;

export interface UnfinishedEditsInput {
  readonly edits: readonly EntityEditRecord[];
  /** Retained rows this build cannot open. Reported, never counted as nothing. */
  readonly unusableEdits?: readonly UnusableEdit[] | undefined;
  /**
   * The owner's answer for one record. Never re-derived here.
   *
   * There is no separate `sending` list: `editStandingOf` already consumes it to tell `saving` from
   * `unconfirmed`, and this projection publishes the standing rather than the flag. A second copy here
   * would be a second authority on the same question.
   */
  readonly standingFor: (editKey: string) => EditStanding | null;
  /** The connection the app is working under, or null when there is none. */
  readonly connectionId: string | null;
}

export const unfinishedEdits = (input: UnfinishedEditsInput): readonly UnfinishedEdit[] => {
  const rows: UnfinishedEdit[] = [];

  for (const record of input.edits) {
    const editKey = editKeyOf(record.key);
    const standing = input.standingFor(editKey);

    // No standing means the owner is not holding this record, so nothing here can say what it means.
    if (standing === null) continue;
    // Everything on the server, with nothing unsent. Not unfinished.
    if (standing.kind === 'synced') continue;

    rows.push({
      key: `edit:${editKey}`,
      editKey,
      nodeId: record.key.nodeId,
      nodeType: record.nodeType,
      title: record.content.title,
      standing: standing.kind,
      endpoint: record.endpoint,
      scope: record.key.connectionId === input.connectionId ? 'current' : 'retired',
      activityAt: record.updatedAt,
      actions: ['open', 'discard'],
    });
  }

  for (const unusable of input.unusableEdits ?? []) {
    const editKey = editKeyOf(unusable.key);

    rows.push({
      key: `unusable-edit:${editKey}`,
      editKey,
      nodeId: unusable.key.nodeId,
      nodeType: unusable.nodeType,
      // Nothing invented: a row whose columns cannot be read may have no title to read either, and
      // saying "Untitled" about one is the card's business, not this projection's.
      title: unusable.title ?? '',
      standing: 'unusable',
      problem: unusable.problem,
      endpoint: unusable.endpoint,
      scope: unusable.key.connectionId === input.connectionId ? 'current' : 'retired',
      // Nothing about it is known to have happened at a time this build can read.
      activityAt: 0,
      // Discard only, and it works by key. Opening it would be a control that answers no, and
      // migrating it is the one thing that is forbidden outright.
      actions: ['discard'],
    });
  }

  // The order is total, so two renders of the same rows never disagree.
  return rows.sort(
    (left, right) =>
      GROUP[left.standing] - GROUP[right.standing] ||
      right.activityAt - left.activityAt ||
      left.key.localeCompare(right.key),
  );
};
