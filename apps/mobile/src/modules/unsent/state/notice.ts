import { create } from 'zustand';

/**
 * One sentence about what happened to someone's writing, for Home to show once: "Saved in Work."
 * or "Kept in Unfinished as a draft." In memory only; a new one replaces an unshown one.
 */
const useNoticeState = create<{ readonly message: string | null }>(() => ({ message: null }));

export const announce = (message: string): void => {
  useNoticeState.setState({ message });
};

export interface Notice {
  readonly message: string | null;
  readonly onHidden: () => void;
}

export const useNotice = (): Notice => ({
  message: useNoticeState((state) => state.message),
  onHidden: () => {
    useNoticeState.setState({ message: null });
  },
});
