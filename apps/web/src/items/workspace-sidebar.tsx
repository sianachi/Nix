import { Button, Icon, Text } from '@nix/ui';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Grid3x3,
  Shapes,
  Trash2,
} from 'lucide-react';
import {
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

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
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * Where a new item goes.
   *
   * **Inside the item you are looking at**, or the workspace when nothing is open.
   *
   * It used to depend on the item's type - inside a folder, beside a note - because a note could
   * not hold anything. Now that every item can, "inside" is the answer for all of them, and it is
   * the simpler rule to hold in your head: what you are looking at is what you are adding to.
   */
  const destination = ((): string | null => {
    if (selectedId === null) {
      return null;
    }

    const selected = tree.find(selectedId);
    if (selected === null) {
      return null;
    }

    return selected.id;
  })();

  const destinationName =
    destination === null ? 'the workspace' : (tree.find(destination)?.title ?? 'this item');

  async function create(title: string, type: string): Promise<void> {
    setRefusal(null);
    const { id: created, refusal: reason } = await tree.create(destination, title, type);

    if (reason !== null) {
      // Shown here, beside the control that was pressed. The refusal names the property at fault,
      // and a message that names a field is only useful next to the thing that has fields.
      setRefusal(reason);
      return;
    }

    // Selected on creation, so the thing that just appeared is the thing in front of you and its
    // name is ready to be typed over. Creating something and leaving it unfound in a tree is how
    // people end up with six items called "Untitled note".
    if (created !== null) {
      onSelect(created);
    }
  }

  return (
    <aside
      aria-label="Workspace"
      className="flex w-[264px] shrink-0 flex-col overflow-hidden bg-surface"
    >
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <Text
          variant="caption"
          as="span"
          tone="muted"
          className="truncate uppercase tracking-wider"
        >
          Workspace
        </Text>

        {/* The label names where the item will land. Two identical buttons whose meaning depends on
            an invisible selection is the kind of control people press twice and then undo. */}
        <Button
          variant="ghost"
          className="ml-auto px-1.5 py-1 text-xs"
          aria-label={`New note in ${destinationName}`}
          onClick={() => {
            void create('Untitled note', 'note');
          }}
          disabled={tree.status !== 'ready' || tree.isCreating}
        >
          <Icon icon={FilePlus} size="sm" />
          Note
        </Button>
        <Button
          variant="ghost"
          className="px-1.5 py-1 text-xs"
          aria-label={`New canvas in ${destinationName}`}
          onClick={() => {
            void create('Untitled canvas', 'canvas');
          }}
          disabled={tree.status !== 'ready' || tree.isCreating}
        >
          <Icon icon={Shapes} size="sm" />
          Canvas
        </Button>
        <Button
          variant="ghost"
          className="px-1.5 py-1 text-xs"
          aria-label={`New spreadsheet in ${destinationName}`}
          onClick={() => {
            void create('Untitled spreadsheet', 'spreadsheet');
          }}
          disabled={tree.status !== 'ready' || tree.isCreating}
        >
          <Icon icon={Grid3x3} size="sm" />
          Sheet
        </Button>
      </div>

      {refusal === null ? null : (
        <p role="alert" className="mx-2 mb-2 rounded-md bg-background px-3 py-2 text-xs">
          {refusal}
        </p>
      )}

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
        <div role="alert" className="mx-2 mb-2 rounded-md bg-background px-3 py-2">
          <Text variant="caption" as="p" tone="muted">
            {tree.error}
          </Text>
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
    return <p className="px-3 py-2 text-sm text-muted">Loading the workspace…</p>;
  }

  if (tree.status === 'error') {
    return (
      <div role="alert" className="px-3 py-2">
        <p className="mb-2 text-sm text-muted">{tree.error}</p>
        <Button
          variant="secondary"
          className="px-2 py-1 text-xs"
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
      <p className="px-3 py-2 text-sm text-muted">
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

/**
 * Where on a row a drop would land.
 *
 * The row's middle band means inside; its top and bottom edges mean before and after, as siblings.
 * This distinction used to come free from the item's type - onto a folder meant inside, onto a note
 * meant beside - and with one kind of item there is nothing left to read it from but the pointer.
 *
 * The middle is deliberately the larger share. Dropping something *into* the thing under the
 * pointer is the common intent and the one that should be easy to hit; reordering is the
 * deliberate act, and its targets sit where a miss lands you inside rather than somewhere
 * surprising.
 */
type DropZone = 'before' | 'inside' | 'after';

const EDGE_BAND = 0.25;

/**
 * How far a row is pushed in for its depth, enumerated as classes.
 *
 * The tree used to compute `paddingLeft` and set it through `style`. Inline styles are banned
 * repository-wide (`app.css` says so, and the rule is why there is one stylesheet), and a CSS
 * custom property assigned through `style` is still an inline style - it moves the value, not the
 * attribute. So the depths are written out.
 *
 * The steps are the drawing's 6px base and 12px per level, rounded onto the spacing scale: a 2-unit
 * base and 3.5 units per level. `--spacing` is 3.4px, so `ROW_INDENT` runs 0.8px wide at the root
 * and closes to exactly the drawn value by its last step.
 *
 * `CHILD_NOTICE_INDENT` is that ladder one level down plus the row's own gutter - the expand chevron
 * (`size-5`) and the gap beside it, 6 units together - so "Loading…" and "Empty" line up with the
 * titles of the children they stand in for rather than with their chevrons. It runs 1.1px wide at
 * the root and 0.4px at its last step: the gutter was written as a round 26px and the chevron and
 * gap it stands for actually measure 20.4px, so these notices end up a hair better aligned than
 * they were drawn. That is the only entry in this file that moves by more than a pixel.
 *
 * **Bounded, deliberately.** Depth is unbounded in principle and the sidebar is 264px wide, so it
 * cannot be unbounded in practice: nine levels already spend 102px of the width, and a tenth would
 * be taken from the title. Past the bound the indent stops growing and deeper rows share the last
 * step. Depth is still carried where it is load-bearing - `role="treeitem"`, `aria-expanded`, and
 * each level's own `role="group"` - so what a tenth level loses is the picture of its depth, not
 * the fact of it, and assistive technology is told the same thing either way.
 *
 * **The two ladders have to stop at the same place**, which is why this one is a step shorter.
 * `CHILD_NOTICE_INDENT[i]` stands for a row at depth `i + 1`, so it runs out one level sooner: with
 * a ninth entry, a notice under a depth-8 node sat 11.9px further in than the children that then
 * replaced it, and the placeholder visibly jumped as they loaded.
 *
 * Both of those are relationships between the two ladders rather than facts about either, so they
 * are asserted in `tree-indent.test.ts` rather than only described here - which is also why all
 * three names below are exported.
 */
export const ROW_INDENT = [
  'pl-2',
  'pl-5.5',
  'pl-9',
  'pl-12.5',
  'pl-16',
  'pl-19.5',
  'pl-23',
  'pl-26.5',
  'pl-30',
] as const;

export const CHILD_NOTICE_INDENT = [
  'pl-11.5',
  'pl-15',
  'pl-18.5',
  'pl-22',
  'pl-25.5',
  'pl-29',
  'pl-32.5',
  'pl-36',
] as const;

/** The step for a depth, clamped to the deepest one the sidebar has room to draw. */
export function indentAt(scale: readonly [string, ...string[]], depth: number): string {
  return scale[Math.min(Math.max(depth, 0), scale.length - 1)] ?? scale[0];
}

export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (height <= 0) {
    return 'inside';
  }

  const position = offsetY / height;

  if (position < EDGE_BAND) {
    return 'before';
  }

  return position > 1 - EDGE_BAND ? 'after' : 'inside';
}

function TreeNode(props: TreeNodeProps): ReactNode {
  const { item, depth, tree, selectedId, onSelect, dragged, setDragged } = props;

  const expanded = tree.isExpanded(item.id);
  const children = tree.childrenOf(item.id);
  const selected = selectedId === item.id;

  // Whether to offer an expand control at all. From the server's answer rather than from the
  // item's type: every item can hold children, so the alternative is a control on every row, most
  // of which would open onto nothing. Kept while expanded so emptying an item does not strip the
  // control out from under the pointer that just opened it.
  const expandable = item.hasChildren || expanded;

  const [zone, setZone] = useState<DropZone | null>(null);
  const dropping = zone !== null && dragged !== null && dragged !== item.id;

  const siblings = tree.childrenOf(item.parentId);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 ? siblings[index + 1] : undefined;

  function onDragStart(event: DragEvent<HTMLDivElement>): void {
    setDragged(item.id);
    event.dataTransfer.effectAllowed = 'move';
    // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
    event.dataTransfer.setData('text/plain', item.id);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();

    const landing = zone;
    setZone(null);

    if (dragged === null || dragged === item.id || landing === null) {
      return;
    }

    // The server refuses an item dropped into its own subtree, so the one gesture that could break
    // the tree is the one it will not perform.
    void (landing === 'inside'
      ? tree.move(dragged, item.id, null)
      : tree.move(dragged, item.parentId, landing === 'after' ? item.id : (previous?.id ?? null)));

    setDragged(null);
  }

  /**
   * The same three moves, from the keyboard.
   *
   * A drop zone that exists only for a pointer is not a move affordance, it is a move affordance
   * for some people. These are the outliner bindings - the ones anybody who has used a list of
   * nested things already has in their fingers - and they map onto exactly the three landings a
   * drag can produce.
   */
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!event.altKey) {
      return;
    }

    if (event.key === 'ArrowUp' && previous !== undefined) {
      event.preventDefault();
      // Before the sibling above, which is after the one above that.
      void tree.move(item.id, item.parentId, siblings[index - 2]?.id ?? null);
      return;
    }

    if (event.key === 'ArrowDown' && next !== undefined) {
      event.preventDefault();
      void tree.move(item.id, item.parentId, next.id);
      return;
    }

    if (event.key === 'ArrowRight' && previous !== undefined) {
      event.preventDefault();
      // Inside the sibling above, which is the only unambiguous "indent": the item below cannot
      // take it without reordering them both.
      void tree.move(item.id, previous.id, null);
      return;
    }

    if (event.key === 'ArrowLeft' && item.parentId !== null) {
      event.preventDefault();
      const parent = tree.find(item.parentId);
      void tree.move(item.id, parent?.parentId ?? null, item.parentId);
    }
  }

  return (
    <li role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-selected={selected}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={() => {
          setDragged(null);
          setZone(null);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          setZone(dropZoneAt(event.clientY - box.top, box.height));
        }}
        onDragLeave={() => {
          setZone(null);
        }}
        onDrop={onDrop}
        className={[
          'group relative flex items-center gap-1 pr-1',
          indentAt(ROW_INDENT, depth),
          selected ? 'bg-accent/18' : 'hover:bg-accent/10',
          dropping && zone === 'inside' ? 'outline-2 -outline-offset-2 outline-accent' : '',
        ].join(' ')}
      >
        {/* A line where the item would land, rather than an outline round the row it would land
            beside. An outline says "into this"; a line between two rows says "between them", which
            is the thing being chosen. */}
        {dropping && zone !== 'inside' ? (
          <span
            aria-hidden="true"
            className={[
              'pointer-events-none absolute inset-x-0 h-0.5 bg-accent',
              zone === 'before' ? 'top-0' : 'bottom-0',
            ].join(' ')}
          />
        ) : null}

        {expandable ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => {
              void tree.toggle(item.id);
            }}
            className="flex size-5 items-center justify-center text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
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
          // On the row's own control rather than on the wrapper: this is the element that takes
          // focus, so it is the one whose keys mean anything, and a div carrying key handlers is a
          // control that only looks like one.
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-base focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <Icon icon={FileText} size="sm" />
          <span className="truncate">{item.title || 'Untitled'}</span>
        </button>

        <button
          type="button"
          aria-label={`Delete ${item.title}`}
          onClick={() => {
            // Asked, because the control is revealed on hover and sits a few pixels from the one
            // that opens the item. Deletion is reversible in the database, but nothing in the
            // interface offers the way back yet, so from here it reads as permanent - and a
            // confirmation is the honest thing until an undo exists.
            const inside = tree.childrenOf(item.id).length;
            const warning =
              inside === 0
                ? `Delete "${item.title || 'Untitled'}"?`
                : `Delete "${item.title || 'Untitled'}" and the ${String(inside)} item${inside === 1 ? '' : 's'} inside it?`;

            if (globalThis.confirm(warning)) {
              void tree.remove(item.id);
            }
          }}
          className="invisible flex size-5 items-center justify-center text-muted hover:text-foreground focus-visible:visible focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent group-hover:visible"
        >
          <Icon icon={Trash2} size="sm" />
        </button>
      </div>

      {expanded ? (
        <ul role="group">
          {tree.isLoadingChildren(item.id) && children.length === 0 ? (
            <li className={`py-1 text-sm text-muted ${indentAt(CHILD_NOTICE_INDENT, depth)}`}>
              Loading…
            </li>
          ) : children.length === 0 ? (
            <li className={`py-1 text-sm text-muted ${indentAt(CHILD_NOTICE_INDENT, depth)}`}>
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
