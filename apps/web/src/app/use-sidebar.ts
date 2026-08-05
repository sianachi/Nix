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

export const WIDTH_STORAGE_KEY = 'nix.sidebar.width';

/**
 * The width the tree starts at, and the range a drag may take it through.
 *
 * The floor is not a taste number: the tree indents 12px per level and bounds itself at nine
 * levels (`ROW_INDENT`), so below about 200px a nested title is down to a few characters and the
 * hover controls start covering them. The ceiling stops a stray drag from leaving the panes
 * narrower than the tree that navigates them.
 */
export const DEFAULT_WIDTH = 264;
export const MINIMUM_WIDTH = 200;
export const MAXIMUM_WIDTH = 480;

/** Whole pixels within the bounds - the one shape a width is allowed to have anywhere. */
export function clampWidth(width: number): number {
  return Math.min(MAXIMUM_WIDTH, Math.max(MINIMUM_WIDTH, Math.round(width)));
}

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

/** Reads the stored width, defaulting - and clamping, since storage is writable by anything. */
export function readWidth(storage: Storage | undefined): number {
  try {
    const raw = storage?.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** Stores a width, tolerating a browser that refuses storage. */
export function storeWidth(storage: Storage | undefined, width: number): void {
  try {
    if (width === DEFAULT_WIDTH) {
      // The default is spelled as absence, for the same reason `collapsed` is: writing it out
      // would leave a later reader unable to tell "never chosen" from "chose the default".
      storage?.removeItem(WIDTH_STORAGE_KEY);
      return;
    }

    storage?.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

export interface Sidebar {
  readonly collapsed: boolean;
  readonly toggle: () => void;

  /** The tree's width in pixels, already clamped to the bounds above. */
  readonly width: number;
  readonly resize: (width: number) => void;
}

export function useSidebar(): Sidebar {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(browserStorage()));
  const [width, setWidth] = useState(() => readWidth(browserStorage()));

  const toggle = useCallback((): void => {
    setCollapsed((current) => {
      const next = !current;
      storeCollapsed(browserStorage(), next);
      return next;
    });
  }, []);

  const resize = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    storeWidth(browserStorage(), clamped);
  }, []);

  return { collapsed, toggle, width, resize };
}
