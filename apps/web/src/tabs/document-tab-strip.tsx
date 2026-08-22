import { Icon, Select, Tabs, Text, cn, focusRing, inkWashStates, type TabItem } from '@nix/ui';
import { PanelLeft, PanelTop } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';

import { useMediaQuery } from '../layout/viewport';
import type { PaneState } from '../panes/pane-state';
import type { ShellContext } from '../shell/shell-context';
import { useSelectedItem } from '../routing/selected-item';
import {
  carriesTabTransfer,
  readTabTransfer,
  writeTabTransfer,
  type TabTransferPayload,
} from './tab-transfer';
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
  readonly visiblePanes: readonly PaneState[];
  readonly draggedTab: TabTransferPayload | null;
  readonly onTabDragStarted: (payload: TabTransferPayload) => void;
  readonly onTabDragEnded: () => void;
  readonly onMoveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
  ) => boolean;

  /** Closes this pane. Absent when it is the only one, matching `OpenItem`'s own `onClose`. */
  readonly onClosePane: (() => void) | undefined;
}

export function DocumentTabStrip({
  paneIndex,
  tree,
  activeItemId,
  visiblePanes,
  draggedTab,
  onTabDragStarted,
  onTabDragEnded,
  onMoveTab,
  onClosePane,
}: DocumentTabStripProps): ReactNode {
  const { tabs } = useDocumentTabs(paneIndex, activeItemId);
  const { clear } = useSelectedItem();
  const { activateTab } = useOpenItem();
  const tabClosed = useTabStore((state) => state.tabClosed);
  const orientation = useTabOrientationStore((state) => state.orientation);
  const orientationToggled = useTabOrientationStore((state) => state.orientationToggled);
  const finePointer = useMediaQuery('(pointer: fine)');
  // The payload object is the drag session token. A cancelled drag may leave this local value
  // behind after its source unmounts, but a later drag creates a different object, so stale
  // highlighting cannot revive before that later pointer actually enters this strip.
  const [dropTarget, setDropTarget] = useState<TabTransferPayload | null>(null);

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

  const activeTitle = items.find((item) => item.id === activeItemId)?.label ?? 'Untitled';
  const destinations = visiblePanes.filter((pane) => pane.index !== paneIndex);
  const canReceive =
    draggedTab !== null &&
    draggedTab.sourcePane !== paneIndex &&
    destinations.some((pane) => pane.index === draggedTab.sourcePane);

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (canReceive && carriesTabTransfer(event.dataTransfer)) {
      event.preventDefault();
      setDropTarget(draggedTab);
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (canReceive && carriesTabTransfer(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    if (!canReceive || !carriesTabTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setDropTarget(null);
    const payload = readTabTransfer(event.dataTransfer);
    if (
      payload !== null &&
      payload.itemId === draggedTab.itemId &&
      payload.sourcePane === draggedTab.sourcePane
    ) {
      const title = tree.find(payload.itemId)?.title ?? '';
      onMoveTab(payload, paneIndex, title);
    }
    onTabDragEnded();
  }

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
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget(null);
        }
      }}
      onDrop={onDrop}
      className={cn(
        'relative flex',
        orientation === 'vertical' ? 'flex-col' : 'flex-row items-center',
        dropTarget === draggedTab &&
          canReceive &&
          'bg-accent/10 outline-2 -outline-offset-2 outline-accent',
      )}
    >
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
        {...(finePointer && destinations.length > 0
          ? {
              drag: {
                onStart: (itemId: string, event: DragEvent<HTMLElement>) => {
                  const payload: TabTransferPayload = {
                    version: 1,
                    itemId,
                    sourcePane: paneIndex,
                  };
                  writeTabTransfer(event.dataTransfer, payload);
                  onTabDragStarted(payload);
                },
                onEnd: () => {
                  setDropTarget(null);
                  onTabDragEnded();
                },
              },
            }
          : {})}
        className="flex-1"
      />

      <div
        className={cn(
          'flex shrink-0',
          orientation === 'vertical' ? 'flex-col items-stretch' : 'flex-row items-center',
        )}
      >
        {destinations.length > 0 ? (
          <Select
            value=""
            aria-label={`Move active tab, ${activeTitle}, to another pane`}
            onChange={(event) => {
              const destination = Number(event.currentTarget.value);
              if (Number.isInteger(destination)) {
                onMoveTab(
                  { version: 1, itemId: activeItemId, sourcePane: paneIndex },
                  destination,
                  activeTitle,
                );
              }
            }}
            className="h-(--control-sm) w-40 max-w-full px-2 text-xs focus-visible:-outline-offset-2"
          >
            <option value="" disabled>
              Move active tab…
            </option>
            {destinations.map((pane) => {
              const title = tree.find(pane.itemId)?.title;
              return (
                <option key={pane.index} value={pane.index}>
                  Pane {String(pane.index + 1)}:{' '}
                  {title !== undefined && title.length > 0 ? title : 'Untitled'}
                </option>
              );
            })}
          </Select>
        ) : null}

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

      {dropTarget === draggedTab && canReceive ? (
        <Text
          as="span"
          variant="caption"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent-fill px-2 py-1 text-background shadow-sm"
        >
          Drop tab here
        </Text>
      ) : null}
    </div>
  );
}
