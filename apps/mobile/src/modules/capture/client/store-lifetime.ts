/**
 * One open of the capture database, for however many owners work over it.
 *
 * Capture is the only capability allowed to open a local database, and from this story it holds two
 * owners - one for creations, one for edits - over two tables in that one file. Two opens would be
 * two connections to the same SQLite file, which is how a single-writer database turns an ordinary
 * autosave into a lock someone waits behind; and the reconciling sweep inside `openCaptureStore`
 * would run twice, once while the other owner was already dispatching what it adopted.
 *
 * Three rules, and each is load-bearing:
 *
 *   an open in progress is joined rather than duplicated, so two owners mounting in the same tick
 *   share one connection rather than racing for it;
 *
 *   an outcome that is not `ready` is **not** remembered, because `retryOpen` exists precisely to
 *   try again after a failure, and a memoized failure would make that button do nothing; and
 *
 *   `close()` closes the one underlying connection and forgets it, so the next open is a real one,
 *   and an open it overtakes closes what it just opened rather than publishing it - otherwise a live
 *   handle would sit outside `opening`, and the call after that would open a second connection to
 *   the same file, which is the one thing this module exists to prevent.
 *
 * That last rule means either owner's `close()` closes the database for both. That is acceptable
 * rather than overlooked: `close()` has no production caller - the layout mounts both lifetimes for
 * the whole process - and every test builds its owners over its own ports.
 */

import { sqlDriver, SQLITE_SUPPORTED } from '../../../infrastructure/sqlite';
import { CAPTURE_DATABASE } from '../schema.ts';
import { openCaptureStore, type CaptureStore, type OpenOutcome } from '../store.ts';

const now = () => Date.now();

/** The live connection, whoever opened it. Null whenever nothing is open. */
let opened: CaptureStore | null = null;
/** The open every caller is sharing, ready or in progress. Cleared by a failure and by `close`. */
let opening: Promise<OpenOutcome> | null = null;
/**
 * Which lifetime this module is on. Incremented by `close`, so an open that comes back afterwards
 * can tell that the connection it is about to publish belongs to a lifetime that has been given up.
 *
 * The same fence `owner.ts` applies to its own open, for the same reason and with the same shape.
 */
let lifetime = 0;

/**
 * Close the one connection, exactly once, and forget it.
 *
 * Taking the handle before awaiting is what makes "once" true: a second `close` from the other owner
 * finds nothing to do rather than closing a connection a later open has already handed out.
 */
const closeShared = async (): Promise<void> => {
  const active = opened;

  // Bumped first, so an open still running is obsolete from this moment on and can see that it is.
  lifetime += 1;
  opened = null;
  opening = null;

  if (active !== null) await active.close();
};

/**
 * One owner's view of the shared connection.
 *
 * Spread rather than delegated field by field, so a method added to `CaptureStore` reaches both
 * owners without anyone remembering to forward it. Only `close` is this module's business.
 */
const share = (store: CaptureStore): CaptureStore => ({ ...store, close: closeShared });

export const openSharedStore = async (): Promise<OpenOutcome> => {
  if (opening === null) {
    const generation = lifetime;
    const running: Promise<OpenOutcome> = (async () => {
      if (!SQLITE_SUPPORTED) return { kind: 'failed', reason: 'unopenable' } satisfies OpenOutcome;

      return openCaptureStore(await sqlDriver.open(CAPTURE_DATABASE), now);
    })().then(
      async (outcome) => {
        // A close landed while this open was running. Recording the connection now would leave a
        // live handle nothing is tracking, so this open closes its own result instead - and then
        // says so, rather than handing back a `ready` outcome over a handle that can no longer serve
        // a request. The owner that called close never sees either answer; its own lifetime fence
        // returns first. A second owner whose open merely overlapped that close does see this one,
        // and an honest unavailable state with a working `retryOpen` - `opening` was cleared - is a
        // better thing to give it than a store that fails everything it is asked.
        if (generation !== lifetime) {
          if (outcome.kind === 'ready') {
            try {
              await outcome.store.close();
            } catch {
              // The module is closing anyway; a close that also fails changes nothing it can report.
            }
          }

          return { kind: 'failed', reason: 'unopenable' };
        }
        if (outcome.kind === 'ready') opened = outcome.store;
        // A failure is never remembered: `retryOpen` has to be able to open a database that was not
        // there a moment ago, and a memoized refusal would make it a no-op forever.
        else if (opening === running) opening = null;

        return outcome;
      },
      (error: unknown) => {
        if (opening === running) opening = null;

        throw error;
      },
    );

    opening = running;
  }

  const outcome = await opening;

  return outcome.kind === 'ready' ? { kind: 'ready', store: share(outcome.store) } : outcome;
};
