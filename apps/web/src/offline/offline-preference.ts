import { create } from 'zustand';

import { browserStorage } from '../lib/browser-storage';

/**
 * Whether notes are kept on this device: a browser-local preference, like the page guides.
 *
 * On by default, because an installed app that cannot open a note offline is not installed in any
 * useful sense. Only the alternative is stored, so the default stays forward-compatible. Turning it
 * off hides the sync footer and stops the runtime scheduling syncs; what is already saved stays
 * until it is cleared from the Notes on this device page.
 */
const KEY = 'nix.offline.enabled';

export function readOfflineEnabled(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

/** The preference outside React, for the sign-in path that remembers the account. */
export function offlineEnabled(): boolean {
  return useOfflinePreference.getState().enabled;
}

export const useOfflinePreference = create<{
  enabled: boolean;
  saved: boolean;
  setEnabled: (value: boolean) => void;
}>((set) => ({
  enabled: readOfflineEnabled(browserStorage()),
  saved: true,
  setEnabled: (enabled) => {
    let saved = false;
    try {
      const storage = browserStorage();
      if (enabled) storage?.removeItem(KEY);
      else storage?.setItem(KEY, 'off');
      saved = storage !== undefined;
    } catch {
      /* The choice still works for this session. */
    }
    set({ enabled, saved });
  },
}));
