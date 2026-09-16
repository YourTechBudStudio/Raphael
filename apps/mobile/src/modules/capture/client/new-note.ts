/**
 * Starting a note: persist first, then open.
 *
 * The order is the whole point. A composer opened over nothing, with the draft created when the
 * first character is typed - or worse, when Save is pressed - is a screen that can hold writing it
 * has nowhere to keep. So the record exists before the route does, and a phone that cannot make one
 * says so instead of opening.
 */

import { useCallback, useRef, useState } from 'react';

import { useConnectionStore } from '../../connection';
import { openCapture } from '../../navigation';
import { useStorageGate } from '../state/storage-gate.ts';
import { useCaptureOwner, useCaptureSession } from './owner.ts';

export interface NewNote {
  readonly start: () => void;
  /** True while a draft is being created. A second press cannot start a second note. */
  readonly busy: boolean;
  /** Why a note could not be started, when the reason is not the app-level storage gate's. */
  readonly problem: string | null;
}

export const useNewNote = (): NewNote => {
  const owner = useCaptureOwner;
  const session = useCaptureSession();
  const latch = useStorageGate((state) => state.latch);
  /**
   * Admission, decided in the same synchronous turn as the press.
   *
   * A ref rather than the `busy` state, for the reason the container request session uses one: two
   * taps in one frame both read the same rendered value, so a state guard would admit both - and
   * each would insert its own draft and push its own route, leaving one of them behind a screen
   * nobody came back to.
   */
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = useCallback(() => {
    if (session === null || starting.current) return;

    starting.current = true;
    setBusy(true);
    setProblem(null);

    void (async () => {
      try {
        const outcome = await owner.getState().createDraft(session);

        if (outcome.kind === 'created') {
          openCapture(outcome.draftId);

          return;
        }

        /**
         * Which kind of refusal this was, without reading its sentence.
         *
         * Every reason `createDraft` can refuse for is either about the connection or about
         * storage, and the two need completely different answers: a connection that moved on is an
         * ordinary, recoverable thing that the next press may well succeed at, while a store that
         * is open and cannot hold a new note is the condition the app does not open past.
         *
         * So the connection is asked again, now, rather than the refusal being pattern-matched on
         * its wording.
         */
        const phase = useConnectionStore.getState().phase;
        const connectionMoved =
          phase.kind !== 'active' ||
          phase.session.activation !== session.activation ||
          phase.rejection !== null;

        if (connectionMoved || owner.getState().status !== 'ready') {
          setProblem(outcome.problem);

          return;
        }

        latch();
      } finally {
        starting.current = false;
        setBusy(false);
      }
    })();
  }, [owner, session, latch]);

  return { start, busy, problem };
};
