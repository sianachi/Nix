import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { WorkspaceTree } from '../items/use-workspace-tree';
import type { PaneState } from '../panes/pane-state';

/**
 * Reveals every item addressed by an open pane once the shell's lazy tree is ready.
 *
 * The tree loads roots first and children on expansion, so a shared link can name an item that is
 * not present yet. Keeping this effect at shell level makes it cover every pane rather than only
 * the active one.
 */
export function useRevealOpenPanes(tree: WorkspaceTree, panes: readonly PaneState[]): void {
  const openIds = panes.map((pane) => pane.itemId).join(' ');

  useEffect(() => {
    if (tree.status !== 'ready') {
      return;
    }

    for (const itemId of openIds.split(' ').filter((id) => id.length > 0)) {
      if (tree.find(itemId) === null) {
        void tree.reveal(itemId);
      }
    }
  }, [openIds, tree]);
}

/** Installs the shell-wide command-palette shortcut while leaving handled inner shortcuts alone. */
export function useShellSearchShortcut(setSearchOpen: Dispatch<SetStateAction<boolean>>): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Inner controls get first refusal. Editor modes use Ctrl+K for their own command, and a
      // handled key must not also open a global surface as it bubbles through the shell.
      if (event.defaultPrevented) {
        return;
      }

      // Both modifiers, because the same browser runs on machines with either.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [setSearchOpen]);
}
