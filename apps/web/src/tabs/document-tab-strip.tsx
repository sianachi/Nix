import { Icon, Tabs, cn, focusRing, inkWashStates, type TabItem } from '@nix/ui';
import { PanelLeft, PanelTop } from 'lucide-react';
import { type ReactNode } from 'react';

import type { ShellContext } from '../shell/shell-context';
import { useSelectedItem } from '../routing/selected-item';
import { useTabOrientationStore } from './tab-orientation-store';
import { useTabStore } from './tab-store';
import { useDocumentTabs } from './use-document-tabs';
import { useOpenItem } from './use-open-item';

/**
 * One pane's open documents.
 *
 * **This is not the tab strip `app-shell.tsx` and `view-switcher.tsx` describe rejecting.** Those
 * rejected turning a *view of one container* (Board vs. List) or a *page in the shell's chrome*
 * into a destination. This strip does neither: it does not choose how to look at anything, and it
 * is not shell chrome - it lives inside one pane and chooses which **item's own screen** (its
 * body, its own `ViewSwitcher`, its own breadcrumbs) that pane currently mounts. A pane held
 * exactly one item before panes could hold more than one at a time; this is that, not a reopening
 * of either prior decision. If you are about to remove this on the grounds that "we already
 * decided against tabs", re-read `pane-state.ts`'s `openBeside` doc comment first - the
 * multi-document problem this solves already existed.
 *
 * Closing the last tab in a pane closes the pane itself, matching an editor group whose last file
 * closes: there is no shape here for an empty pane to render, and inventing one would be a second
 * way to say "nothing is open" beside the one `EditorPage` already has. Closing the last tab of
 * the last pane clears the selection instead, which is the same empty state.
 *
 * **Horizontal or vertical is one preference for every pane, not one per pane** - see
 * `tab-orientation-store.ts`. The toggle lives here, beside the tabs it changes, rather than in a
 * settings screen this product does not otherwise have one of.
 */
export interface DocumentTabStripProps {
  readonly paneIndex: number;
  readonly tree: ShellContext['tree'];
  readonly activeItemId: string;

  /** Closes this pane. Absent when it is the only one, matching `OpenItem`'s own `onClose`. */
  readonly onClosePane: (() => void) | undefined;
}

export function DocumentTabStrip({
  paneIndex,
  tree,
  activeItemId,
  onClosePane,
}: DocumentTabStripProps): ReactNode {
  const { tabs } = useDocumentTabs(paneIndex, activeItemId);
  const { clear } = useSelectedItem();
  const { activateTab } = useOpenItem();
  const tabClosed = useTabStore((state) => state.tabClosed);
  const orientation = useTabOrientationStore((state) => state.orientation);
  const orientationToggled = useTabOrientationStore((state) => state.orientationToggled);

  const items: TabItem[] = tabs.map((tab) => {
    const title = tree.find(tab.itemId)?.title;

    return {
      id: tab.itemId,
      // `??` alone would not catch an empty string, and an untitled note is ordinary - the same
      // reasoning `editor-page.tsx`'s `describe()` gives for a pane's own fallback name.
      label: title !== undefined && title.length > 0 ? title : 'Untitled',
      pinned: tab.pinned,
    };
  });

  function handleClose(itemId: string): void {
    const index = tabs.findIndex((tab) => tab.itemId === itemId);
    const remaining = tabs.filter((tab) => tab.itemId !== itemId);

    tabClosed(itemId);

    if (remaining.length === 0) {
      if (onClosePane === undefined) {
        clear();
      } else {
        onClosePane();
      }
      return;
    }

    if (itemId === activeItemId) {
      // The immediate left neighbour, falling back to the right when the closed tab was
      // leftmost - the same convention VS Code's own tab strip uses.
      const neighbor = remaining[Math.max(0, index - 1)];
      if (neighbor !== undefined) {
        activateTab(neighbor.itemId);
      }
    }
  }

  return (
    <div className={cn('flex', orientation === 'vertical' ? 'flex-col' : 'flex-row items-center')}>
      <Tabs
        label="Open documents"
        items={items}
        activeId={activeItemId}
        orientation={orientation}
        onActivate={(itemId) => {
          if (itemId !== activeItemId) {
            activateTab(itemId);
          }
        }}
        onClose={handleClose}
        className="flex-1"
      />

      {/* Beside the strip it changes, not in a settings screen this product does not have one
          of. The icon names the *destination* layout, the same convention the sidebar's own
          collapse control uses. */}
      <button
        type="button"
        aria-label={
          orientation === 'vertical' ? 'Show tabs across the top' : 'Show tabs on the side'
        }
        onClick={orientationToggled}
        className={cn(
          'flex shrink-0 items-center justify-center p-1.5 text-muted hover:text-foreground',
          focusRing,
          inkWashStates,
        )}
      >
        <Icon icon={orientation === 'vertical' ? PanelTop : PanelLeft} size="sm" />
      </button>
    </div>
  );
}
