import { Button, Icon, Text } from '@nix/ui';
import { ArrowLeft, ChevronRight, FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { PaneViewport } from '../layout/pane-viewport';
import { useHiddenItems } from './use-hidden-items';
import { HiddenItemsPanel } from './hidden-items-panel';
import type { WorkspaceTree } from './use-workspace-tree';

export function MobileWorkspaceBrowser({
  tree,
  parentId,
  onParent,
  onOpen,
}: {
  readonly tree: WorkspaceTree;
  readonly parentId: string | null;
  readonly onParent: (id: string | null) => void;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const visibility = useHiddenItems();
  const visible = tree.childrenOf(parentId).filter((item) => !visibility.hiddenSet.has(item.id));
  const parent = parentId === null ? null : tree.find(parentId);
  const loading =
    tree.status === 'loading' || (parentId !== null && tree.isLoadingChildren(parentId));
  return (
    <aside aria-label="Workspace" className="flex min-h-0 w-full flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-divider p-3">
        {parentId !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              onParent(parent?.parentId ?? null);
            }}
          >
            <Icon icon={ArrowLeft} size="sm" />
            Up
          </Button>
        ) : (
          <Text variant="h3" as="h2">
            Workspace
          </Text>
        )}
      </div>
      {parent ? (
        <Button
          variant="ghost"
          className="justify-start px-3"
          onClick={() => {
            onOpen(parent.id);
          }}
        >
          Open {parent.title || 'Untitled'}
        </Button>
      ) : null}
      {loading ? (
        <Text variant="note" role="status" className="p-3">
          Loading items…
        </Text>
      ) : null}
      {tree.error ? (
        <div className="p-3">
          <Text variant="note" role="alert">
            {tree.error}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              if (parentId) void tree.expand(parentId);
              else void tree.reload();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <PaneViewport
        scrollKey={`mobile-workspace:${parentId ?? 'root'}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        <HiddenItemsPanel onOpen={onOpen} />
        {visible.map((item) => (
          <div key={item.id} className="flex items-center border-b border-divider">
            <Button
              variant="ghost"
              className="min-h-12 min-w-0 flex-1 justify-start text-left"
              onClick={() => {
                onOpen(item.id);
              }}
            >
              <Icon icon={FileText} size="sm" />
              <Text as="span" variant="bodySmall" className="truncate">
                {item.title || 'Untitled'}
              </Text>
            </Button>
            <Button
              variant="ghost"
              aria-label={`Hide ${item.title || 'Untitled'} for me`}
              onClick={() => {
                visibility.hide(item.id, item.title);
              }}
            >
              Hide
            </Button>
            <Button
              variant="icon"
              className="min-h-12 min-w-12"
              aria-label={`Browse children of ${item.title || 'Untitled'}`}
              onClick={() => {
                onParent(item.id);
                void tree.expand(item.id);
              }}
            >
              <Icon icon={ChevronRight} size="sm" />
            </Button>
          </div>
        ))}
        {!loading && !tree.error && visible.length === 0 ? (
          <Text as="p" variant="note" tone="muted" className="p-3">
            {tree.childrenOf(parentId).length > 0
              ? 'Items here are hidden for you.'
              : 'No items here yet. Use New note to create one.'}
          </Text>
        ) : null}
      </PaneViewport>
    </aside>
  );
}
