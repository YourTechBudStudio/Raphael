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

/** The cards Home leads its grid with: this connection's unfinished notes, in the same order. */
export const useHomeUnfinishedNotes = (): readonly UnfinishedNote[] => {
  const notes = useUnfinishedNotes();

  return useMemo(() => notes.filter((note) => note.onHome), [notes]);
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
