import { create } from 'zustand';

import { browserStorage } from '../../lib/browser-storage';

/**
 * General browser preferences.
 *
 * On by default: only the 'off' preference is stored in localStorage so that
 * defaults stay forward-compatible.
 */
const FOOTER_VISIBLE_KEY = 'nix.footer-visible';

export function readFooterVisible(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(FOOTER_VISIBLE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export interface GeneralPreferencesState {
  readonly footerVisible: boolean;
  readonly setFooterVisible: (visible: boolean) => void;
}

export const useGeneralPreferences = create<GeneralPreferencesState>((set) => ({
  footerVisible: readFooterVisible(browserStorage()),
  setFooterVisible: (visible: boolean) => {
    try {
      const storage = browserStorage();
      if (visible) {
        storage?.removeItem(FOOTER_VISIBLE_KEY);
      } else {
        storage?.setItem(FOOTER_VISIBLE_KEY, 'off');
      }
    } catch {
      // Storage unavailable or disabled
    }
    set({ footerVisible: visible });
  },
}));

/** Helper selector outside React or for convenience */
export function footerVisible(): boolean {
  return useGeneralPreferences.getState().footerVisible;
}
