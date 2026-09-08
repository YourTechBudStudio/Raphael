import { create } from 'zustand';

import type { CaptureTarget, ParentRef } from '../../../infrastructure/api/contracts';

export type SheetKind = 'browse' | 'new-note' | 'voice-capture';

interface SheetsState {
  /** Which sheet is open, or null when none is. */
  open: SheetKind | null;
  /** The location Browse highlights as current. Null when opened from Home. */
  browseCurrent: ParentRef | null;
  /** Where a capture flow writes. 'home' means the inbox area. */
  captureTarget: CaptureTarget;
  openBrowse: (current?: ParentRef | null) => void;
  openNewNote: (target: CaptureTarget) => void;
  openVoiceCapture: (target: CaptureTarget) => void;
  close: () => void;
}

export const useSheetsStore = create<SheetsState>((set) => ({
  open: null,
  browseCurrent: null,
  captureTarget: { type: 'home' },
  openBrowse: (current = null) => {
    set({ open: 'browse', browseCurrent: current });
  },
  openNewNote: (target) => {
    set({ open: 'new-note', captureTarget: target });
  },
  openVoiceCapture: (target) => {
    set({ open: 'voice-capture', captureTarget: target });
  },
  close: () => {
    set({ open: null });
  },
}));
