/**
 * Keeping an `unsent` row in step with what is on screen, for the composer and the editor alike.
 *
 * Fields are written as they are typed, and the body about half a second after the editor last
 * reported it. `flush` writes everything on screen once more - the fields and a fresh copy of the
 * body - and answers only when that write has reached SQLite, and never when the editor did not hand
 * over what it holds. The store runs writes in the order they were asked for, so that answer covers
 * every earlier write too. Close and Save wait for it, and stay put if it failed, so writing is never
 * left behind on a screen that has gone.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AppState } from 'react-native';

import type { EditorPort, EditorSnapshot } from '../../editor';
import type { UnsentRow } from '../../unsent';

const BODY_DEBOUNCE_MS = 500;

export type Patch = Partial<
  Pick<UnsentRow, 'title' | 'description' | 'slug' | 'tags' | 'body' | 'destination'>
>;

export interface RowWriting {
  readonly write: (patch: Patch) => void;
  readonly onSnapshot: (snapshot: EditorSnapshot) => void;
  /** Writes what is on screen and answers whether it reached SQLite. */
  readonly flush: () => Promise<boolean>;
  /** Stops every write from here on, the one on unmount included: the writing was just discarded. */
  readonly abandon: () => void;
  /** A local write did not reach SQLite, and nothing written since has made up for it. */
  readonly failed: boolean;
}

/**
 * `onScreen` gives everything the screen shows except the body, which comes from the editor: the
 * fields, and what the Details and destination sheets committed, so a flush covers them too.
 */
export const useRowWriting = (
  save: (patch: Patch) => Promise<boolean>,
  port: RefObject<EditorPort | null>,
  onScreen: () => Patch,
): RowWriting => {
  const [failed, setFailed] = useState(false);
  const latest = useRef({ save, onScreen });
  /** The newest body the editor reported, written or not. */
  const body = useRef<{ readonly value: unknown } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abandoned = useRef(false);

  latest.current = { save, onScreen };

  const persist = useCallback(async (patch: Patch): Promise<boolean> => {
    if (abandoned.current) return true;

    const ok = await latest.current.save(patch);

    if (!ok) setFailed(true);

    return ok;
  }, []);

  const write = useCallback(
    (patch: Patch) => {
      void persist(patch);
    },
    [persist],
  );

  const writeBody = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (body.current !== null) void persist({ body: body.current.value });
  }, [persist]);

  const onSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      body.current = { value: snapshot.document };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(writeBody, BODY_DEBOUNCE_MS);
    },
    [writeBody],
  );

  const flush = useCallback(async () => {
    const result = await port.current?.requestSnapshot();

    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;

    const shown = (): Patch => ({
      ...latest.current.onScreen(),
      ...(body.current === null ? {} : { body: body.current.value }),
    });

    // An editor that will not hand over what it holds may hold writing it has not reported yet - its
    // first edit is only reported after a short pause - so this flush cannot let the screen go. What
    // it did report is still written now, since the pending write for it was just cancelled.
    if (result?.kind !== 'captured') {
      await persist(shown());
      setFailed(true);

      return false;
    }
    body.current = { value: result.snapshot.document };

    const ok = await persist(shown());

    if (ok) setFailed(false);

    return ok;
  }, [port, persist]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void flush();
    });

    // The editor is being torn down with the screen and cannot be asked any more, so this writes
    // what it last reported. Close flushes first, while it still can.
    return () => {
      subscription.remove();
      writeBody();
    };
  }, [flush, writeBody]);

  const abandon = useCallback(() => {
    abandoned.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  return { write, onSnapshot, flush, abandon, failed };
};
