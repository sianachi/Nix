import type { PaneState } from '../panes/pane-state';
import type { OpenTab } from './tab-store';

/**
 * Finds the one addressed pane that owns a document.
 *
 * The URL's active document wins over session-local background tabs. Otherwise, the first
 * addressed pane recording the tab owns it. Keeping this precedence in one pure function makes
 * the open path and every rendered tab strip enforce the same collaboration-session invariant.
 */
export function ownerOfItem(
  itemId: string,
  addressedPanes: readonly PaneState[],
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
): number | null {
  const active = addressedPanes.find((pane) => pane.itemId === itemId);
  if (active !== undefined) {
    return active.index;
  }

  const background = addressedPanes.find((pane) =>
    (byPane[pane.index] ?? []).some((tab) => tab.itemId === itemId),
  );
  return background?.index ?? null;
}
