import { create } from 'zustand';
import { browserStorage } from '../lib/browser-storage';

const KEY = 'nix.mobile-toolbar-visibility';
export type ToolbarVisibility = 'always' | 'while-writing';
export function readToolbarVisibility(storage: Storage | undefined): ToolbarVisibility {
  try {
    return storage?.getItem(KEY) === 'while-writing' ? 'while-writing' : 'always';
  } catch {
    return 'always';
  }
}
export const useMobileToolbarPreference = create<{
  visibility: ToolbarVisibility;
  saved: boolean;
  setVisibility: (value: ToolbarVisibility) => void;
}>((set) => ({
  visibility: readToolbarVisibility(browserStorage()),
  saved: true,
  setVisibility: (visibility) => {
    let saved = false;
    try {
      const storage = browserStorage();
      storage?.setItem(KEY, visibility);
      saved = storage !== undefined;
    } catch {
      /* The choice still works for this session. */
    }
    set({ visibility, saved });
  },
}));
