/**
 * THROWAWAY MOCK. Pretends to save, or to replay a save the server never answered. Either way
 * the outcome is whatever the gallery selected: it may work, fail, or stay unknown.
 */

import { useEffect, useRef, useState } from 'react';

import { useMockStore, type MockOutcome } from '../state';

/** A fresh save sends the form; a replay sends the frozen request from the unconfirmed attempt. */
export type SaveMode = 'save' | 'replay';

export type SavePhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'done'; outcome: MockOutcome };

export function useMockSave(onResult: (mode: SaveMode, outcome: MockOutcome) => void) {
  const outcome = useMockStore((state) => state.outcome);
  const [phase, setPhase] = useState<SavePhase>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const save = (mode: SaveMode) => {
    setPhase({ kind: 'saving' });
    const result: MockOutcome = outcome;

    timer.current = setTimeout(() => {
      setPhase(result === 'saved' ? { kind: 'idle' } : { kind: 'done', outcome: result });
      onResult(mode, result);
    }, 1200);
  };

  const reset = () => {
    setPhase({ kind: 'idle' });
  };

  return { phase, save, reset, locked: phase.kind === 'saving' };
}
