/**
 * THROWAWAY MOCK. What the gallery lets you simulate, and the one message Home shows after a save.
 */

import { create } from 'zustand';

import {
  MOCK_DRAFTS,
  MOCK_NOTES,
  type MockDestination,
  type MockDraft,
  type MockNode,
  type MockNote,
} from './data';

/** Enough notes to scroll: the seeds repeated with fresh ids and numbered titles. */
const manyNotes = (seeds: readonly MockNote[], count: number): readonly MockNote[] =>
  Array.from({ length: count }, (_, index) => {
    const seed = seeds[index % seeds.length] as MockNote;

    return index < seeds.length
      ? seed
      : {
          ...seed,
          id: 1000 + index,
          title: `${seed.title} ${String(Math.floor(index / seeds.length) + 1)}`,
        };
  });

export type MockOutcome = 'saved' | 'uncertain' | 'refused';

export interface HomeNotice {
  readonly title: string;
  readonly destination: MockDestination;
}

type NoteInput = Omit<MockNote, 'id' | 'revision'>;

/** What the phone's own storage is doing while you write. */
export type MockStorage = 'fine' | 'write_failing' | 'editor_refuses';
/** What Home's notes query returns. */
export type MockHomeNotes = 'many' | 'none' | 'failed';

interface MockState {
  outcome: MockOutcome;
  /** Notes with no confirmed copy on the server, newest first. */
  drafts: readonly MockDraft[];
  discardDraft: (id: number) => void;
  /** A draft saved from the editor: it becomes a note and leaves the unfinished list. */
  saveDraft: (id: number, note: NoteInput) => number;
  /** Adds or replaces an unfinished note. */
  putDraft: (draft: MockDraft) => void;
  /** Home's pull-to-refresh, pretended: a moment of spinner, nothing changes. */
  refreshing: boolean;
  refresh: () => void;
  storage: MockStorage;
  setStorage: (storage: MockStorage) => void;
  homeNotes: MockHomeNotes;
  setHomeNotes: (homeNotes: MockHomeNotes) => void;
  /** False when opening a saved note fails to read its body from the server. */
  noteOpens: boolean;
  setNoteOpens: (noteOpens: boolean) => void;

  /** Sends the frozen request again. In the mock the server answers this time. */
  retryDraft: (id: number) => void;

  setOutcome: (outcome: MockOutcome) => void;
  notes: readonly MockNote[];
  addNote: (note: Omit<MockNote, 'id' | 'revision'>) => number;
  updateNote: (id: number, note: Omit<MockNote, 'id' | 'revision'>) => void;
  /** How many notes Home has scrolled into view. */
  shown: number;
  showMore: () => void;
  /** Browse draws the mock hierarchy instead of the server's. */
  mockBrowse: boolean;
  setMockBrowse: (on: boolean) => void;
  homeNotice: HomeNotice | null;
  setHomeNotice: (notice: HomeNotice | null) => void;
  created: readonly { node: MockNode; parentId: number | null }[];
  addCreated: (node: MockNode, parentId: number | null) => void;
}

export const useMockStore = create<MockState>((set, get) => ({
  outcome: 'saved',
  setOutcome: (outcome) => {
    set({ outcome });
  },
  drafts: MOCK_DRAFTS,
  discardDraft: (id) => {
    set((state) => ({ drafts: state.drafts.filter((draft) => draft.id !== id) }));
  },
  saveDraft: (id, note) => {
    const noteId = get().addNote(note);
    get().discardDraft(id);

    return noteId;
  },
  putDraft: (draft) => {
    set((state) => ({
      drafts: [draft, ...state.drafts.filter((candidate) => candidate.id !== draft.id)],
    }));
  },
  storage: 'fine',
  setStorage: (storage) => {
    set({ storage });
  },
  homeNotes: 'many',
  setHomeNotes: (homeNotes) => {
    set({ homeNotes });
  },
  noteOpens: true,
  setNoteOpens: (noteOpens) => {
    set({ noteOpens });
  },
  refreshing: false,
  refresh: () => {
    set({ refreshing: true });
    setTimeout(() => {
      set({ refreshing: false });
    }, 900);
  },
  retryDraft: (id) => {
    const draft = get().drafts.find((candidate) => candidate.id === id);
    if (draft === undefined || draft.destination === null) return;

    const title = draft.title === '' ? 'Untitled note' : draft.title;
    get().saveDraft(id, { ...draft, title, destination: draft.destination });
    set({ homeNotice: { title, destination: draft.destination } });
  },
  notes: manyNotes(MOCK_NOTES, 60),
  addNote: (note) => {
    const id = 42 + get().notes.length;
    set((state) => ({ notes: [{ ...note, id, revision: 1 }, ...state.notes] }));

    return id;
  },
  updateNote: (id, note) => {
    set((state) => ({
      notes: state.notes.map((candidate) =>
        candidate.id === id
          ? { ...candidate, ...note, revision: candidate.revision + 1 }
          : candidate,
      ),
    }));
  },
  shown: 10,
  showMore: () => {
    set((state) => ({ shown: Math.min(state.shown + 10, state.notes.length) }));
  },
  mockBrowse: true,
  setMockBrowse: (mockBrowse) => {
    set({ mockBrowse });
  },
  homeNotice: null,
  setHomeNotice: (homeNotice) => {
    set({ homeNotice });
  },
  created: [],
  addCreated: (node, parentId) => {
    set((state) => ({ created: [...state.created, { node, parentId }] }));
  },
}));

export const STORAGE_LABEL: Record<MockStorage, string> = {
  fine: 'Writes fine',
  write_failing: 'Cannot write the draft',
  editor_refuses: 'Editor refuses (too large)',
};

export const HOME_NOTES_LABEL: Record<MockHomeNotes, string> = {
  many: 'Has notes',
  none: 'No notes',
  failed: 'Fails to load',
};

export const OUTCOME_LABEL: Record<MockOutcome, string> = {
  saved: 'Server saves it',
  uncertain: 'Response is lost',
  refused: 'Server refuses it',
};
