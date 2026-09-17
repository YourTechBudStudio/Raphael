/**
 * The owner's records, as the two screens that draw them need them.
 *
 * Every hook here is a selector plus a memo over the pure projections in `../unfinished.ts`. The
 * selectors read stable slices - the owner replaces an array only when a record in it changes - so
 * the memo recomputes when something actually happened rather than on every render.
 *
 * Nothing here decides anything. `standingFor` is passed through to the projection, so the certainty
 * policy is still answered in exactly one place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { savedIn } from '../copy.ts';
import {
  pendingReceipts,
  unfinishedNotes,
  type SaveReceipt,
  type UnfinishedNote,
} from '../unfinished.ts';
import { useDestinationName } from './destinations.ts';
import { useEditOwner } from './edit-owner.ts';
import { useUnfinishedEdits } from './edits.ts';
import { useCaptureOwner, useCaptureSession } from './owner.ts';

/** Everything unfinished on this phone, most pressing first, current connection and retired alike. */
export const useUnfinishedNotes = (): readonly UnfinishedNote[] => {
  const drafts = useCaptureOwner((state) => state.drafts);
  const unusableDrafts = useCaptureOwner((state) => state.unusableDrafts);
  const attempts = useCaptureOwner((state) => state.attempts);
  const unsaved = useCaptureOwner((state) => state.unsaved);
  const sending = useCaptureOwner((state) => state.sending);
  const standingFor = useCaptureOwner((state) => state.standingFor);
  const session = useCaptureSession();
  const connectionId = session?.connectionId ?? null;

  return useMemo(
    () =>
      unfinishedNotes({
        drafts,
        unusableDrafts,
        attempts,
        unsaved,
        sending,
        standingFor,
        connectionId,
      }),
    [drafts, unusableDrafts, attempts, unsaved, sending, standingFor, connectionId],
  );
};

/**
 * What Home's one indicator needs: how much is not on the server, and whether that is the whole of it.
 *
 * A tally and not a count, in the name as well as the shape. A count alone is the thing this hook
 * exists to argue against - it cannot tell "nothing is unfinished" from "this phone could not find
 * out" - so a name promising one would be the same mistake said in a different place.
 *
 * A tally rather than a number, because **zero and "could not read it" must not be the same value.**
 * Home draws no unfinished cards any more and Settings' entry is gone, so this chip is the only door
 * to Recovery: a store that failed to open would otherwise report zero, draw no chip, and leave both
 * the unsent work and the failure behind a door nothing opens. That is the invisibility this
 * indicator exists to prevent, and it is the same argument that puts `unreadableAttempts` in the
 * count below.
 *
 * `complete` is false only for `unavailable`, never for a store still opening. An open in flight
 * settles on its own within a moment and resolves to the truth; an unavailable one never does. Saying
 * "something could not be read" during ordinary startup would put a chip on every cold launch of a
 * phone with nothing unfinished.
 *
 * **It counts everything Recovery draws.** Both projections are taken whole, retired-scope rows
 * included, because Recovery lists those too - a chip that disagreed with the screen it opens would be
 * worse than either number alone. `unreadableAttempts` is in it because Recovery reports those rows as
 * well, in a line rather than a card. Transient rows count: a record that is saving right now is still
 * something the person has that the server does not, and excluding it would make the number drop
 * mid-save and climb back on a refusal.
 */
export interface UnfinishedTally {
  readonly count: number;
  /** False when a store could not be read, so `count` is a floor rather than a total. */
  readonly complete: boolean;
}

export const useUnfinishedTally = (): UnfinishedTally => {
  const notes = useUnfinishedNotes();
  const edits = useUnfinishedEdits();
  const unreadable = useCaptureOwner((state) => state.unreadableAttempts);
  const captureStatus = useCaptureOwner((state) => state.status);
  const editStatus = useEditOwner((state) => state.status);

  return {
    count: notes.length + edits.length + unreadable,
    complete: captureStatus !== 'unavailable' && editStatus !== 'unavailable',
  };
};

/**
 * The next success waiting to be told, and the way to say it has been told.
 *
 * `consume` is called when the snackbar has actually been shown, never on mount, on navigation, or
 * on a cache refresh: the receipt is retained precisely so that a success nobody saw survives a
 * crash and is reported on the next launch instead of disappearing.
 */
export const useSaveReceipt = (): {
  readonly receipt: SaveReceipt | null;
  readonly consume: (attemptId: string) => void;
} => {
  const attempts = useCaptureOwner((state) => state.attempts);
  const consumeReceipt = useCaptureOwner((state) => state.consumeReceipt);
  const session = useCaptureSession();
  const connectionId = session?.connectionId ?? null;

  const queue = useMemo(() => pendingReceipts(attempts, connectionId), [attempts, connectionId]);

  return {
    receipt: queue[0] ?? null,
    consume: useCallback(
      (attemptId: string) => {
        void consumeReceipt(attemptId);
      },
      [consumeReceipt],
    ),
  };
};

/**
 * The one success notice, and when it is spent.
 *
 * It lives here rather than in Home because the policy is capture's: a receipt is retained precisely
 * so that a success nobody was shown survives the process that earned it, and it is spent when it
 * has actually been on screen. Home renders the notice; it does not decide any of that.
 *
 * Three rules are in the small amount of state here.
 *
 * The notice is held in this hook rather than read from the record, because the record is removed
 * the moment it is shown - a message read straight off the queue would be on screen for a few
 * milliseconds and then vanish mid-animation.
 *
 * A receipt is announced **once per mount**, whether or not spending it worked. A consumption that
 * fails leaves the row recoverable by design, and without this it would be the very next thing the
 * queue offers: the notice would reappear the instant it left, for as long as the write kept
 * failing. It is offered again after a later recovery or a restart, which is what the retained row
 * is for.
 *
 * And one at a time, oldest first, so two receipts are two notices in a fixed order rather than one
 * winning a race.
 */
export const useSaveNotice = (): {
  readonly message: string | null;
  readonly onShown: () => void;
  readonly onHidden: () => void;
} => {
  const { receipt, consume } = useSaveReceipt();
  const nameOf = useDestinationName();
  const [notice, setNotice] = useState<{ attemptId: string; message: string } | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (receipt === null || notice !== null) return;
    if (announced.current.has(receipt.attemptId)) return;

    announced.current.add(receipt.attemptId);
    setNotice({
      attemptId: receipt.attemptId,
      message: savedIn(nameOf(receipt.destination).spoken),
    });
  }, [receipt, notice, nameOf]);

  return {
    message: notice?.message ?? null,
    onShown: () => {
      // Spent because it was shown, not because a screen mounted, navigated or refreshed. A spend
      // that fails leaves a recoverable record rather than a lost success.
      if (notice !== null) consume(notice.attemptId);
    },
    onHidden: () => {
      setNotice(null);
    },
  };
};

/**
 * The actions a card can offer, bound to the owner.
 *
 * Each one refuses honestly rather than throwing: a copy attempted with no connection is a refusal
 * with a sentence, which is what the caller shows. Nothing here retries, rebinds, or resends on its
 * own.
 */
export const useUnfinishedActions = () => {
  const owner = useCaptureOwner;
  const session = useCaptureSession();

  return {
    copy: useCallback(
      async (draftId: string) => {
        if (session === null) {
          return {
            kind: 'refused' as const,
            problem: 'Connect to a server before copying this into a new note.',
          };
        }

        return owner.getState().copyDraft(draftId, session);
      },
      [owner, session],
    ),
    discard: useCallback((draftId: string) => owner.getState().discardDraft(draftId), [owner]),
    recordAgain: useCallback(
      (attemptId: string) => owner.getState().saveAcknowledgement(attemptId),
      [owner],
    ),
    dismiss: useCallback(
      (attemptId: string) => owner.getState().consumeReceipt(attemptId),
      [owner],
    ),
  };
};
