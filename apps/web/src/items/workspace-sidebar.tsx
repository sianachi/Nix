import { Button, Icon } from '@nix/ui';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FolderPlus,
  Folder,
  Trash2,
} from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';

import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * The workspace tree, in the sidebar, always on screen.
 *
 * It is part of the shell rather than of a page because it is how you move around the product; a
 * tree that appeared only on the editor screen would make every other screen a dead end you had to
 * navigate back out of.
 *
 * **Reordering and reparenting are drags, and a drag is a document edit like any other.** It goes
 * through the move endpoint, which refuses a folder dropped into its own subtree, so the one
 * genuinely destructive gesture in a tree is the one the server will not perform.
 */

export interface WorkspaceSidebarProps {
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly onSelect: (itemId: string) => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps): ReactNode {
  const { tree, selectedId, onSelect } = props;
  const [dragged, setDragged] = useState<string | null>(null);

  return (
    <aside
      aria-label="Workspace"
      className="flex w-[264px] shrink-0 flex-col border-r border-divider bg-neutral-100"
    >
      <div className="flex items-center gap-1 border-b border-divider px-3 py-2">
        <span className="text-[11px] uppercase tracking-[0.08em] text-foreground/60">
          Workspace
        </span>

        <Button
          variant="ghost"
          className="ml-auto px-1.5 py-1 text-[11px]"
          onClick={() => {
            void tree.create(null, 'Untitled note');
          }}
          disabled={tree.status !== 'ready' || tree.isCreating}
        >
          <Icon icon={FilePlus} size="sm" />
          Note
        </Button>

        <Button
          variant="ghost"
          className="px-1.5 py-1 text-[11px]"
          onClick={() => {
            void tree.create(null, 'Untitled folder', 'folder');
          }}
          disabled={tree.status !== 'ready' || tree.isCreating}
        >
          <Icon icon={FolderPlus} size="sm" />
          Folder
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TreeBody
          tree={tree}
          selectedId={selectedId}
          onSelect={onSelect}
          dragged={dragged}
          setDragged={setDragged}
        />
      </div>

      {/* The error lives at the foot rather than replacing the tree: a failed rename must not take
          away the items that loaded perfectly well. */}
      {tree.error === null ? null : (
        <div role="alert" className="border-t border-divider px-3 py-2">
          <p className="text-[11px] text-foreground/70">{tree.error}</p>
        </div>
      )}
    </aside>
  );
}

interface TreeBodyProps {
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly onSelect: (itemId: string) => void;
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
}

function TreeBody(props: TreeBodyProps): ReactNode {
  const { tree } = props;

  if (tree.status === 'loading') {
    return <p className="px-3 py-2 text-[12px] text-foreground/60">Loading the workspace…</p>;
  }

  if (tree.status === 'error') {
    return (
      <div role="alert" className="px-3 py-2">
        <p className="mb-2 text-[12px] text-foreground/70">{tree.error}</p>
        <Button
          variant="secondary"
          className="px-2 py-1 text-[11px]"
          onClick={() => {
            void tree.reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const roots = tree.childrenOf(null);
  if (roots.length === 0) {
    return (
      <p className="px-3 py-2 text-[12px] text-foreground/60">
        Nothing here yet. &ldquo;Note&rdquo; creates the first item.
      </p>
    );
  }

  return (
    <ul role="tree" aria-label="Items" className="py-1">
      {roots.map((item) => (
        <TreeNode key={item.id} item={item} depth={0} {...props} />
      ))}
    </ul>
  );
}

interface TreeNodeProps extends TreeBodyProps {
  readonly item: TreeItem;
  readonly depth: number;
}

function TreeNode(props: TreeNodeProps): ReactNode {
  const { item, depth, tree, selectedId, onSelect, dragged, setDragged } = props;

  const isFolder = item.type === 'folder';
  const expanded = tree.isExpanded(item.id);
  const children = tree.childrenOf(item.id);
  const selected = selectedId === item.id;
  const [dropTarget, setDropTarget] = useState(false);

  function onDragStart(event: DragEvent<HTMLDivElement>): void {
    setDragged(item.id);
    event.dataTransfer.effectAllowed = 'move';
    // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
    event.dataTransfer.setData('text/plain', item.id);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDropTarget(false);

    if (dragged === null || dragged === item.id) {
      return;
    }

    // Dropping onto a folder puts the item inside it; onto a note, immediately after it. The
    // server refuses a folder dropped into its own subtree, so the one gesture that could break
    // the tree is the one it will not perform.
    void (isFolder
      ? tree.move(dragged, item.id, null)
      : tree.move(dragged, item.parentId, item.id));

    setDragged(null);
  }

  return (
    <li role="treeitem" aria-expanded={isFolder ? expanded : undefined} aria-selected={selected}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={() => {
          setDragged(null);
          setDropTarget(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget(true);
        }}
        onDragLeave={() => {
          setDropTarget(false);
        }}
        onDrop={onDrop}
        className={[
          'group flex items-center gap-1 pr-1',
          selected ? 'bg-accent-100' : 'hover:bg-accent-100/60',
          dropTarget && dragged !== null && dragged !== item.id
            ? 'outline-2 -outline-offset-2 outline-accent'
            : '',
        ].join(' ')}
        style={{ paddingLeft: `${String(depth * 12 + 6)}px` }}
      >
        {isFolder ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => {
              void tree.toggle(item.id);
            }}
            className="flex size-5 items-center justify-center text-foreground/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="sm" />
          </button>
        ) : (
          <span aria-hidden="true" className="size-5" />
        )}

        <button
          type="button"
          onClick={() => {
            onSelect(item.id);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        >
          <Icon icon={isFolder ? Folder : FileText} size="sm" />
          <span className="truncate">{item.title || 'Untitled'}</span>
        </button>

        <button
          type="button"
          aria-label={`Delete ${item.title}`}
          onClick={() => {
            void tree.remove(item.id);
          }}
          className="invisible flex size-5 items-center justify-center text-foreground/50 hover:text-foreground focus-visible:visible focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent group-hover:visible"
        >
          <Icon icon={Trash2} size="sm" />
        </button>
      </div>

      {isFolder && expanded ? (
        <ul role="group">
          {tree.isLoadingChildren(item.id) && children.length === 0 ? (
            <li
              className="py-1 text-[12px] text-foreground/60"
              style={{ paddingLeft: `${String((depth + 1) * 12 + 26)}px` }}
            >
              Loading…
            </li>
          ) : children.length === 0 ? (
            <li
              className="py-1 text-[12px] text-foreground/60"
              style={{ paddingLeft: `${String((depth + 1) * 12 + 26)}px` }}
            >
              Empty
            </li>
          ) : (
            children.map((child) => (
              <TreeNode key={child.id} {...props} item={child} depth={depth + 1} />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}
