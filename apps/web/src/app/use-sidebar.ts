import { useCallback, useState } from 'react';

import { browserStorage } from '../theme/theme-store';

/**
 * Whether the workspace tree is on screen.
 *
 * **Remembered, not held for the session.** Somebody who collapses the tree has decided they want
 * the width, and reopening the application to find it back would make the control feel like it did
 * not work. It is stored the same way the theme is, and for the same reason.
 *
 * **Not in the URL**, unlike the selected item or the active view. Those describe *what* is being
 * looked at and belong in a link somebody can share; this describes how one person's window is
 * arranged, and sending it to a colleague would collapse their sidebar for them.
 */

export const STORAGE_KEY = 'nix.sidebar';

const COLLAPSED = 'collapsed';

/** Reads the stored state, defaulting to open. */
export function readCollapsed(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === COLLAPSED;
  } catch {
    // Private browsing, or a policy that blocks storage. A sidebar that forgets is a small loss.
    return false;
  }
}

/** Stores the state, tolerating a browser that refuses storage. */
export function storeCollapsed(storage: Storage | undefined, collapsed: boolean): void {
  try {
    if (collapsed) {
      storage?.setItem(STORAGE_KEY, COLLAPSED);
      return;
    }

    // Open is the default, and absent already means it. Writing a second spelling of the same
    // state would leave a later reader unable to tell "never chosen" from "chose the default".
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

export interface Sidebar {
  readonly collapsed: boolean;
  readonly toggle: () => void;
}

export function useSidebar(): Sidebar {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(browserStorage()));

  const toggle = useCallback((): void => {
    setCollapsed((current) => {
      const next = !current;
      storeCollapsed(browserStorage(), next);
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
