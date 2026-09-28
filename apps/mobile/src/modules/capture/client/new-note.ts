/**
 * Starting a note: a draft row first, then the composer over it, so there is never a composer with
 * nowhere to keep what is typed.
 */

import { useCallback, useRef, useState } from 'react';

import { openCapture } from '../../navigation';
import { startDraft } from '../../unsent';
import { NOT_KEPT_STATUS } from '../copy.ts';

export interface NewNote {
  readonly start: () => void;
  /** True while the draft is being created. A second press cannot start a second note. */
  readonly busy: boolean;
  readonly problem: string | null;
}

export const useNewNote = (): NewNote => {
  // A ref, so two taps in one frame cannot both start a note.
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = useCallback(() => {
    if (starting.current) return;

    starting.current = true;
    setBusy(true);
    setProblem(null);

    void startDraft({ nodeType: 'resource', kind: 'note', destination: null })
      .then((id) => {
        if (id === null) setProblem(`${NOT_KEPT_STATUS.text}.`);
        else openCapture(id);
      })
      .finally(() => {
        starting.current = false;
        setBusy(false);
      });
  }, []);

  return { start, busy, problem };
};
