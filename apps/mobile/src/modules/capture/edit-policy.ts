/**
 * Where one edit record stands, as one answer.
 *
 * Pure, and separate from the owner for the reason `policy.ts` is: the evaluation order below is a
 * correctness rule, not a presentation choice. It decides which single sentence a person is told about
 * their writing, and every wrong ordering tells them something false about work that is not on a
 * server yet.
 *
 * The order is: the server's verdicts first (`conflicted`, `refused`), then what this phone cannot
 * establish (`unconfirmed`), then what it cannot attempt (`offline`), then the ordinary states.
 * Protection is *not* here - it outranks all of this and is applied by `edit-composer.ts`, because it
 * is a fact about this phone rather than about a server.
 *
 * `offline` is derived only when there is an unsent committed version. A record with nothing to send
 * reports `synced` whatever the connectivity, because saying "kept on this phone" over writing that is
 * already on the server is the mirror-image overclaim.
 */

import type { EditRefusal, EntityEditRecord } from './edit-types.ts';

export type EditStanding =
  /** Everything written here is on the server, at this revision. */
  | { readonly kind: 'synced'; readonly revision: number }
  /** Unsent writing, and a session that could send it. */
  | { readonly kind: 'pending' }
  /** Unsent writing, and nothing able to send it. Never "saving soon". */
  | { readonly kind: 'offline' }
  /** A request is in the air right now, dispatched by this process. */
  | { readonly kind: 'saving' }
  /** An envelope was dispatched and its answer was never seen. Not a claim that it failed. */
  | { readonly kind: 'unconfirmed' }
  /**
   * The server refused the last change. The refusal may be null: it is a diagnostic label, and the
   * record's own state carries the fact.
   */
  | { readonly kind: 'refused'; readonly refusal: EditRefusal | null }
  /** The entity changed on the server since it was opened. The local writing is kept, never merged. */
  | { readonly kind: 'conflicted' };

export interface EditStandingInput {
  readonly record: EntityEditRecord;
  /** The last version the store confirmed, from protection. Only this may ever be sent. */
  readonly committedVersion: number;
  /** True while this process has a request in the air for this record. */
  readonly sending: boolean;
  /** A current, usable session on this record's own connection. */
  readonly sessionUsable: boolean;
}

export const editStandingOf = (input: EditStandingInput): EditStanding => {
  const { record } = input;

  // A verdict the server gave outranks anything this phone would otherwise say about the same record.
  // Both keep the writing; neither is repaired by waiting.
  if (record.syncState === 'conflicted') return { kind: 'conflicted' };
  if (record.syncState === 'refused') return { kind: 'refused', refusal: record.lastRefusal };

  // An envelope in flight, told apart by whether *this* process is the one flying it. A record read
  // back after a process death has an `inflightVersion` and no dispatcher, and "checking your server"
  // is the honest sentence for it - not "saving", which would claim a request that no longer exists.
  if (record.inflightVersion !== null) {
    return input.sending ? { kind: 'saving' } : { kind: 'unconfirmed' };
  }

  // Unsent writing is measured against what the *store* confirmed, never against the latest accepted
  // version: a version that is not on disk cannot be sent, so counting it here would report work as
  // waiting to go when it is not yet safe to send.
  if (input.committedVersion > record.acknowledgedVersion) {
    return input.sessionUsable ? { kind: 'pending' } : { kind: 'offline' };
  }

  return { kind: 'synced', revision: record.baseRevision };
};
