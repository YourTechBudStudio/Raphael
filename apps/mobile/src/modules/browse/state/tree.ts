import { create } from 'zustand';

interface BrowseState {
  /** Ids of the expanded tree nodes. Persists across sheet opens. */
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  /** Expands the given ids without collapsing anything, used for ancestors of the current node. */
  expandMany: (ids: readonly string[]) => void;
}

export const useBrowseStore = create<BrowseState>((set) => ({
  expanded: new Set<string>(),
  toggle: (id) => {
    set((state) => {
      const next = new Set(state.expanded);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return { expanded: next };
    });
  },
  expandMany: (ids) => {
    set((state) => {
      if (ids.every((id) => state.expanded.has(id))) {
        return state;
      }

      const next = new Set(state.expanded);

      for (const id of ids) {
        next.add(id);
      }

      return { expanded: next };
    });
  },
}));
