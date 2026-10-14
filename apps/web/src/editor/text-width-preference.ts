import { create } from 'zustand';

import { browserStorage } from '../lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '../lib/ui-settings-sync';

export const TEXT_WIDTH_STORAGE_KEY = 'nix.text-width';
export type TextWidth = 'reading' | 'full';

export function loadTextWidth(storage: Storage | undefined): {
  readonly width: TextWidth;
  readonly saved: boolean;
} {
  try {
    return {
      width: storage?.getItem(TEXT_WIDTH_STORAGE_KEY) === 'full' ? 'full' : 'reading',
      saved: storage !== undefined,
    };
  } catch {
    return { width: 'reading', saved: false };
  }
}

export const useTextWidthPreference = create<{
  readonly width: TextWidth;
  readonly saved: boolean;
  readonly setWidth: (width: TextWidth) => void;
}>((set) => ({
  ...loadTextWidth(browserStorage()),
  setWidth: (width) => {
    let saved = false;
    try {
      const storage = browserStorage();
      if (width === 'reading') storage?.removeItem(TEXT_WIDTH_STORAGE_KEY);
      else storage?.setItem(TEXT_WIDTH_STORAGE_KEY, width);
      saved = storage !== undefined;
    } catch {
      // Blocked storage still allows changing the width for this session.
    }
    set({ width, saved });
    settingChanged('editor.textWidth', width);
  },
}));

registerSyncedSetting('editor.textWidth', {
  get: () => useTextWidthPreference.getState().width,
  set: (width) => {
    useTextWidthPreference.getState().setWidth(width);
  },
  defaultValue: 'reading',
});
