import { create } from 'zustand';

/**
 * Which overlay is open, and nothing about what it will do.
 *
 * The capture sheets used to be told where to write when they were opened, and the "home" target
 * meant an invisible inbox area. Both are gone. A note's destination is chosen inside the sheet,
 * explicitly, every time - so there is no destination to carry here, and no way for a caller to
 * open a sheet that quietly writes somewhere nobody picked.
 *
 * Container creation is not here either. It is phase 09 work, and leaving an action on this store
 * that nothing renders would be a way back into it; removing the action makes the boundary
 * something a test can check rather than something a reviewer has to trust.
 */

export type SheetKind = 'new-note' | 'voice-capture';

interface SheetsState {
  /** Which sheet is open, or null when none is. */
  open: SheetKind | null;
  /**
   * Counts openings. A sheet stays mounted while closed, so without an identity that changes per
   * opening, opening it a second time would show the previous one's finished state instead of a
   * fresh form.
   */
  session: number;
  openNewNote: () => void;
  openVoiceCapture: () => void;
  close: () => void;
}

export const useSheetsStore = create<SheetsState>((set) => ({
  open: null,
  session: 0,
  openNewNote: () => {
    set((state) => ({ open: 'new-note', session: state.session + 1 }));
  },
  openVoiceCapture: () => {
    set((state) => ({ open: 'voice-capture', session: state.session + 1 }));
  },
  close: () => {
    set({ open: null });
  },
}));
