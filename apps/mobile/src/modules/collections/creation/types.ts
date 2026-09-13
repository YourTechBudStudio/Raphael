/**
 * The shapes the creation machine works in, kept with the machine that uses them.
 *
 * These were on the app's backend boundary while a mock repository implemented container creation.
 * That mock is gone: phase 08 removed every production path into it, so there is nothing behind
 * this boundary to declare. The reducer and its tests are kept because the behaviour they encode
 * was reviewed and settled, and phase 09 builds the real creation on them - so its vocabulary lives
 * here, private to the module, rather than in a boundary file describing an operation no code in
 * this release performs.
 *
 * Ids are the server's numeric ids, which is the one change phase 08 made to them.
 */

import type { ContainerRef, ContainerType } from '../../../infrastructure/api/contracts';

/** What a creation makes and where. The root holds only areas, so a null parent implies an area. */
export interface ContainerTarget {
  type: ContainerType;
  parentAreaId: number | null;
}

/** What a creation request came back with. */
export type CreateContainerOutcome =
  | { kind: 'created'; container: ContainerRef & { title: string } }
  | {
      kind: 'rejected';
      reason: 'collision' | 'title_unusable' | 'parent_missing' | 'other';
      message: string;
    }
  /**
   * The request left and no answer arrived. It may or may not exist, and only a check by key can
   * say. Never a failure a sheet may quietly retry as though nothing had been sent.
   */
  | { kind: 'uncertain' };

/** What the server says about an earlier attempt when asked by its key. */
export type AttemptCheck =
  | { kind: 'created'; container: ContainerRef & { title: string } }
  | { kind: 'not_created' }
  | { kind: 'expired' };

/**
 * An attempt whose outcome is unknown, kept so it can be resolved later rather than repeated. It
 * carries its whole payload, because resolving it means asking about or resending exactly what was
 * sent, not something reassembled from what is on screen now.
 */
export interface PendingAttempt extends ContainerTarget {
  attemptKey: string;
  title: string;
  description: string;
  body: string;
}
