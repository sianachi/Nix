import { create } from 'zustand';

import { browserStorage } from '../lib/browser-storage';

/**
 * Whether the page guides are drawn: a browser-local preference, like the mobile toolbar's.
 *
 * Shown by default. The guides exist for the person writing to a page count, and that person
 * has no way to know the feature exists if it starts hidden; the person who never exports can
 * switch them off once and never see them again. Only the alternative is stored, so the default
 * stays forward-compatible.
 */
const KEY = 'nix.page-guides';

export type PageGuideVisibility = 'shown' | 'hidden';

export function readPageGuideVisibility(storage: Storage | undefined): PageGuideVisibility {
  try {
    return storage?.getItem(KEY) === 'hidden' ? 'hidden' : 'shown';
  } catch {
    return 'shown';
  }
}

export const usePageGuidePreference = create<{
  visibility: PageGuideVisibility;
  saved: boolean;
  setVisibility: (value: PageGuideVisibility) => void;
}>((set) => ({
  visibility: readPageGuideVisibility(browserStorage()),
  saved: true,
  setVisibility: (visibility) => {
    let saved = false;
    try {
      const storage = browserStorage();
      if (visibility === 'hidden') {
        storage?.setItem(KEY, visibility);
      } else {
        storage?.removeItem(KEY);
      }
      saved = storage !== undefined;
    } catch {
      /* The choice still works for this session. */
    }
    set({ visibility, saved });
  },
}));
