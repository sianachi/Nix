import { create } from 'zustand';

import { browserStorage } from '../lib/browser-storage';

/**
 * Whether the note editor suggests phrase completions as muted text at the caret: a browser-local
 * preference, like the page guides and the mobile toolbar.
 *
 * **Off by default.** The accept key is Right Arrow at the end of a block (see `ghost-text.ts` for
 * why that key), which is also an ordinary navigation key there. A suggestion is only drawn after
 * a pause in typing, so the overlap is narrow - but a writer who has never heard of the feature,
 * pauses at the end of a line and presses Right Arrow to move on would find words they did not
 * write in a shared document, already sent to every collaborator. Asking for the feature once is
 * a small price against that surprise. Only the alternative is stored, so the default stays
 * forward-compatible if that judgement changes.
 */
const KEY = 'nix.phrase-suggestions';

export type GhostTextSetting = 'on' | 'off';

export function readGhostTextSetting(storage: Storage | undefined): GhostTextSetting {
  try {
    return storage?.getItem(KEY) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export const useGhostTextPreference = create<{
  setting: GhostTextSetting;
  saved: boolean;
  setSetting: (value: GhostTextSetting) => void;
}>((set) => ({
  setting: readGhostTextSetting(browserStorage()),
  saved: true,
  setSetting: (setting) => {
    let saved = false;
    try {
      const storage = browserStorage();
      if (setting === 'on') {
        storage?.setItem(KEY, setting);
      } else {
        storage?.removeItem(KEY);
      }
      saved = storage !== undefined;
    } catch {
      /* The choice still works for this session. */
    }
    set({ setting, saved });
  },
}));
