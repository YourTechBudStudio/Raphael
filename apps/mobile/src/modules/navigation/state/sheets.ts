import { create } from 'zustand';

import type { ContainerType } from '../../../infrastructure/api/contracts';

/**
 * Which overlay is open, and - for the ones that act on something - what it is acting on.
 *
 * The capture sheets carry nothing. They used to be told where to write when they were opened, and
 * from Home that meant an invisible inbox area; a note's destination is now chosen inside the sheet,
 * explicitly, every time, so there is no destination to carry and no way to open one that quietly
 * writes somewhere nobody picked.
 *
 * **Container creation does carry a destination, and that is not the same bug.** The note default
 * was silent - nobody chose it and nothing said what it was. A creation destination is the thing
 * that was tapped: Create area *inside this area*. Refusing to carry it would mean either asking
 * again for something already chosen, or inferring it from the current route, which is the inference
 * that was removed.
 *
 * Resuming carries a durable attempt id and nothing else. Copying a stored payload into navigation
 * state would make an immutable record into something a route could hold a stale copy of; the owner
 * loads and validates the record instead.
 */

export type OpenSheet =
  | { readonly kind: 'new-note' }
  | { readonly kind: 'voice-capture' }
  | {
      readonly kind: 'new-container';
      readonly containerType: ContainerType;
      /** Null creates at the root, which holds only areas. */
      readonly parentAreaId: number | null;
    }
  | { readonly kind: 'resume-container'; readonly attemptId: string };

interface SheetsState {
  /** Which sheet is open, or null when none is. One at a time, always. */
  open: OpenSheet | null;
  /**
   * Counts openings. A sheet stays mounted while closed, so without an identity that changes per
   * opening, opening it a second time would show the previous one's finished state instead of a
   * fresh form.
   */
  session: number;
  openNewNote: () => void;
  openVoiceCapture: () => void;
  openNewContainer: (containerType: ContainerType, parentAreaId: number | null) => void;
  resumeContainer: (attemptId: string) => void;
  close: () => void;
}

export const useSheetsStore = create<SheetsState>((set) => {
  const show = (sheet: OpenSheet) => {
    set((state) => ({ open: sheet, session: state.session + 1 }));
  };

  return {
    open: null,
    session: 0,
    openNewNote: () => {
      show({ kind: 'new-note' });
    },
    openVoiceCapture: () => {
      show({ kind: 'voice-capture' });
    },
    openNewContainer: (containerType, parentAreaId) => {
      show({ kind: 'new-container', containerType, parentAreaId });
    },
    resumeContainer: (attemptId) => {
      show({ kind: 'resume-container', attemptId });
    },
    close: () => {
      set({ open: null });
    },
  };
});
