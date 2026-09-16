/**
 * Asking the editor for a copy on the way out of the foreground.
 *
 * Writing that exists only in the renderer is the one thing a process death can take, and the moment
 * a phone is most likely to end a process is just after it leaves the foreground. So the last thing
 * capture does on the way out is ask.
 *
 * **Unlocked, and supplementary.** It passes no lock because nobody is navigating and the person may
 * come straight back to a live editor - locking it would leave the screen refusing keystrokes for a
 * reason that had nothing to do with them. That also means this flush can never be the barrier a
 * Save relies on: a snapshot taken with the edit window open is not "the last word", which is why
 * Save, Retry and every controlled transition take their own locked one. This only shortens the
 * window in which the renderer holds something native does not.
 *
 * It is explicitly best effort. `inactive` and `background` are notice, not a guarantee of time, and
 * a forced kill gives no notice at all - which the design says plainly and this does not contradict.
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useCaptureOwner } from './owner.ts';

/** The states that mean the foreground is going away. iOS passes through `inactive` first. */
const LEAVING = new Set<AppStateStatus>(['inactive', 'background']);

export const useBackgroundFlush = (draftId: string): void => {
  const owner = useCaptureOwner;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (!LEAVING.has(next)) return;

      // Nothing is awaited and no outcome is reported: there is no screen left to report one to,
      // and the owner records a failed write on the draft's protection either way - which is what
      // the composer reads when someone comes back.
      void owner.getState().flush(draftId);
    });

    return () => {
      subscription.remove();
    };
  }, [owner, draftId]);
};
