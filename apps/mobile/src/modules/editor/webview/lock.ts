/**
 * When it is safe to stop accepting input, and what to do when it never becomes safe.
 *
 * An in-progress IME composition is not in the document yet, so locking and reading immediately
 * would capture text the person can see but `getJSON()` cannot. Blurring establishes nothing:
 * `prosemirror-view`'s blur handler neither ends composition nor flushes pending records, and
 * `compositionend` itself defers by a 20 ms timer. So this waits out a quiet window on observable
 * signals only, restarts it whenever anything happens, rechecks at the transition, and gives up
 * honestly rather than locking mid-word or waiting forever.
 *
 * It is deliberately DOM-free and takes its timing and its composition signal as inputs: that is
 * what makes "a `compositionstart` arriving just before the window expires" a test rather than a
 * hope. The browser entry wires the real events and the real `view.composing` to it.
 */

export interface LockTiming {
  /** Milliseconds of quiet required before the lock is applied. Longer than the framework's 20 ms. */
  readonly settleMs: number;
  /** The whole pending state is bounded by this, so continuous typing ends in a refusal. */
  readonly deadlineMs: number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface LockSignals {
  /** `view.composing`, read at the transition rather than remembered. */
  readonly isComposing: () => boolean;
  /** The quiet window passed its recheck: apply `editable = false` now. */
  readonly onLocked: () => void;
  /** The deadline passed. The editor stays editable and the caller is refused. */
  readonly onFailed: () => void;
}

export interface LockCoordinator {
  /** Begin a pending lock. Ignored when one is already pending or applied. */
  readonly request: () => void;
  /** Unlock, cancellation, or session retirement. Drops any pending work immediately. */
  readonly cancel: () => void;
  readonly noteCompositionStart: () => void;
  readonly noteCompositionEnd: () => void;
  readonly noteTransaction: () => void;
  readonly isPending: () => boolean;
  readonly isLocked: () => boolean;
}

export const createLockCoordinator = (
  timing: LockTiming,
  signals: LockSignals,
): LockCoordinator => {
  let pending = false;
  let locked = false;
  let window: unknown = null;
  let deadline: unknown = null;
  /** Counts events that must invalidate a window in flight; compared at the recheck. */
  let activity = 0;
  let windowActivity = 0;

  const clearWindow = () => {
    if (window !== null) {
      timing.clearTimer(window);
      window = null;
    }
  };

  const finish = () => {
    clearWindow();
    if (deadline !== null) {
      timing.clearTimer(deadline);
      deadline = null;
    }
    pending = false;
  };

  const startWindow = () => {
    clearWindow();
    // A composition in progress means the window does not run at all. It starts from the following
    // `compositionend`, not from a guess about when the composition will finish.
    if (signals.isComposing()) return;
    windowActivity = activity;
    window = timing.setTimer(() => {
      window = null;
      if (!pending) return;
      // The lock is applied only at a transition that rechecks. Either signal saying otherwise keeps
      // it pending and restarts the window; there is no "restart once", and an unlimited restart is
      // safe because it cannot outlive the deadline.
      if (signals.isComposing() || activity !== windowActivity) {
        startWindow();
        return;
      }
      finish();
      locked = true;
      signals.onLocked();
    }, timing.settleMs);
  };

  const renew = () => {
    activity += 1;
    if (pending) startWindow();
  };

  return {
    request: () => {
      if (pending || locked) return;
      pending = true;
      activity += 1;
      deadline = timing.setTimer(() => {
        deadline = null;
        if (!pending) return;
        finish();
        // The editor was never made read-only: `contenteditable` is not touched while the lock is
        // merely pending, which is the point of pending being a state at all.
        signals.onFailed();
      }, timing.deadlineMs);
      startWindow();
    },
    cancel: () => {
      finish();
      locked = false;
    },
    noteCompositionStart: () => {
      activity += 1;
      clearWindow();
    },
    noteCompositionEnd: renew,
    noteTransaction: renew,
    isPending: () => pending,
    isLocked: () => locked,
  };
};
