import { create } from 'zustand';

import type {
  CaptureTarget,
  ContainerTarget,
  PendingAttempt,
} from '../../../infrastructure/api/contracts';

export type SheetKind = 'new-note' | 'voice-capture' | 'new-container';

interface SheetsState {
  /** Which sheet is open, or null when none is. */
  open: SheetKind | null;
  /** Where a capture flow writes. 'home' means the inbox area. */
  captureTarget: CaptureTarget;
  /** What the creation sheet makes, and under which area. */
  containerTarget: ContainerTarget;
  /** An earlier unresolved attempt the creation sheet reopens on, or null for a fresh one. */
  resumeAttempt: PendingAttempt | null;
  /**
   * Counts openings of the creation sheet. The sheet stays mounted while closed, so without an
   * identity that changes per opening, a second creation for the same destination would reopen
   * the previous one's finished or unresolved state instead of a blank form.
   */
  containerSession: number;
  openNewNote: (target: CaptureTarget) => void;
  openVoiceCapture: (target: CaptureTarget) => void;
  openNewContainer: (target: ContainerTarget) => void;
  /** Reopens the creation sheet on an attempt whose outcome is still unknown. */
  resumeContainer: (attempt: PendingAttempt) => void;
  close: () => void;
}

export const useSheetsStore = create<SheetsState>((set) => ({
  open: null,
  captureTarget: { type: 'home' },
  containerTarget: { type: 'area', parentAreaId: null },
  resumeAttempt: null,
  containerSession: 0,
  openNewNote: (target) => {
    set({ open: 'new-note', captureTarget: target });
  },
  openVoiceCapture: (target) => {
    set({ open: 'voice-capture', captureTarget: target });
  },
  openNewContainer: (target) => {
    set((state) => ({
      open: 'new-container',
      containerTarget: target,
      resumeAttempt: null,
      containerSession: state.containerSession + 1,
    }));
  },
  resumeContainer: (attempt) => {
    set((state) => ({
      open: 'new-container',
      containerTarget: { type: attempt.type, parentAreaId: attempt.parentAreaId },
      resumeAttempt: attempt,
      containerSession: state.containerSession + 1,
    }));
  },
  close: () => {
    set({ open: null });
  },
}));
