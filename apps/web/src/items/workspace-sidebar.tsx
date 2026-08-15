import { Button, Icon, Text, cn, disabledState, fieldLabel, focusRing } from '@nix/ui';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FilePlus,
  FileText,
  Grid3x3,
  ListFilter,
  Plus,
  Shapes,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { announce } from '../a11y/announcer';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { SMART_LISTS, type SmartListPreset } from '../views/query/smart-lists';
import { useBookmarksStore } from '../bookmarks/use-bookmarks';
import { BESIDE_REFUSAL_COPY, type BesideRefusal } from '../panes/pane-state';
import type { TreeItem, WorkspaceTree } from './use-workspace-tree';

/**
 * Whether this is an Apple platform, for the one gesture whose modifier differs.
 *
 * Read once, from the user agent's own platform hint rather than by sniffing a version string.
 * It matters because Ctrl+click is the *secondary* click on a Mac: accepting it as "open beside"
 * there would turn every attempt to open a context menu into a new pane.
 */
const APPLE = /mac|iphone|ipad|ipod/i.test(
  // The modern hint where it exists, the user-agent string where it does not. Deliberately not
  // `navigator.platform`, which is deprecated and frozen to a lie on several browsers.
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.userAgent,
);

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

  /**
   * Opens an item in a pane beside the ones already open.
   *
   * Separate from `onSelect` because it is a different intention - "as well as", not "instead
   * of" - and because the shell is the only thing that knows how many panes there are and
   * whether another will fit.
   */
  readonly onOpenBeside: (itemId: string) => void;

  /**
   * Commits to an item as a permanent tab, rather than the preview tab a plain click leaves
   * behind. A double-click, in the row's own established grammar - the same gesture a file
   * manager already uses to mean "open this one for real".
   */
  readonly onOpenPinned: (itemId: string) => void;

  /** Whether another pane would fit. A control that silently refuses reads as a broken one. */
  readonly canOpenBeside: boolean;

  /** Why not, when it would not - so the control can say which of two reasons it is. */
  readonly besideRefusal: BesideRefusal | null;

  /**
   * Deletes an item. Owned by `app-shell.tsx` rather than by this component - see its own
   * `requestDelete` for the full reasoning - because the undo toast it shows lives at shell level,
   * not nested inside whatever is currently presenting this sidebar. On a phone that presenter is
   * the off-canvas drawer (`sidebar-drawer.tsx`), and a toast nested inside it would unmount, undo
   * window and all, the moment the drawer closes - which is the very next thing a phone user does
   * after deleting something, to get back to their document.
   */
  readonly onDeleteItem: (item: TreeItem) => void;

  /**
   * Where focus should land once a delete toast's undo window closes, by any path. Supplied by
   * `app-shell.tsx` - which owns the toast - rather than created here, so the shell can pass the
   * same ref to `<Toast returnFocusRef>`. The row that opened a toast is gone by then - deleted,
   * which is why there is a toast at all - so there is no invoker to return focus to the way
   * `<Dialog>` does; this scroll region is the nearest thing that is still guaranteed to be there.
   */
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;

  /**
   * Stores a preset's query view on a freshly created smart list, answering with the refusal or
   * null. Supplied by the shell rather than performed here, because the write needs the session's
   * token and this component deliberately has no auth dependency - it renders in tests and in any
   * host that hands it a tree.
   */
  readonly applySmartListViews: (itemId: string, preset: SmartListPreset) => Promise<string | null>;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps): ReactNode {
  const {
    tree,
    selectedId,
    onSelect,
    onOpenBeside,
    onOpenPinned,
    canOpenBeside,
    besideRefusal,
    onDeleteItem,
    treeRegionRef,
    applySmartListViews,
  } = props;
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

  async function createSmartList(preset: SmartListPreset): Promise<void> {
    setRefusal(null);
    const { id: created, refusal: reason } = await tree.create(destination, preset.title, 'query');

    if (reason !== null) {
      setRefusal(reason);
      return;
    }

    if (created === null) {
      return;
    }

    // The view is stored after the create, and a failure here is reported rather than rolled
    // back: the item exists either way, and its filters can be added under Views. Silence would
    // leave somebody opening an empty document wondering where their list went.
    const viewsRefusal = await applySmartListViews(created, preset);
    if (viewsRefusal !== null) {
      setRefusal(viewsRefusal);
    }

    onSelect(created);
  }

  return (
    // The width belongs to the shell, which sizes and resizes the region this fills; a width
    // here as well would be two owners for one dimension.
    <aside aria-label="Workspace" className="flex w-full flex-col overflow-hidden bg-surface">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        {/* The published label look, composed onto a span: `<Text>`'s className is layout only,
            and this was reaching through it for uppercase and tracking - which is the type axis the
            variant is supposed to own. `fieldLabel` is that same treatment, stated once. */}
        <span className={cn('truncate', fieldLabel)}>Workspace</span>

        <CreateMenu
          destinationName={destinationName}
          disabled={tree.status !== 'ready' || tree.isCreating}
          onCreate={(title, type) => {
            void create(title, type);
          }}
          onCreateSmartList={(preset) => {
            void createSmartList(preset);
          }}
        />
      </div>

      {refusal === null ? null : (
        <Text
          variant="caption"
          as="p"
          role="alert"
          className="mx-2 mb-2 rounded-md bg-background px-3 py-2"
        >
          {refusal}
        </Text>
      )}

      {/* `tabIndex={-1}`: not in the tab order on its own, but a legitimate script-focusable
          landing spot - see `treeRegionRef`'s own comment on why the delete toast returns focus
          here rather than to the row it deleted, which is gone by the time that matters. */}
      <div ref={treeRegionRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
        <TreeBody
          tree={tree}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenBeside={onOpenBeside}
          onOpenPinned={onOpenPinned}
          canOpenBeside={canOpenBeside}
          besideRefusal={besideRefusal}
          dragged={dragged}
          setDragged={setDragged}
          onDeleteItem={onDeleteItem}
        />
      </div>

      {/* The error lives at the foot rather than replacing the tree: a failed rename must not take
          away the items that loaded perfectly well. It is also where a failed delete surfaces -
          `app-shell.tsx`'s `requestDelete` shows no toast at all when `tree.remove` refuses, so
          this is the only report of it. */}
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

/**
 * The kinds of item the menu offers, which is to say the body kinds this client can draw.
 *
 * `item.type` is an open string on the server - there is one kind of item, and the type only
 * says how its body renders - so this list is the client's vocabulary, not the schema's.
 */
const CREATABLE_KINDS: readonly {
  readonly type: string;
  readonly label: string;
  readonly title: string;
  readonly icon: LucideIcon;
}[] = [
  { type: 'note', label: 'Note', title: 'Untitled note', icon: FilePlus },
  { type: 'canvas', label: 'Canvas', title: 'Untitled canvas', icon: Shapes },
  { type: 'spreadsheet', label: 'Sheet', title: 'Untitled spreadsheet', icon: Grid3x3 },
];

interface CreateMenuProps {
  readonly destinationName: string;
  readonly disabled: boolean;
  readonly onCreate: (title: string, type: string) => void;

  /** Creates a smart list from a preset: an item of type `query` carrying the preset's view. */
  readonly onCreateSmartList: (preset: SmartListPreset) => void;
}

/**
 * One "New" control opening a menu of kinds, rather than a button per kind.
 *
 * Three buttons in the header left the tree's title about a third of the row, and every kind
 * added would take another bite. A menu spends one control's width however many kinds exist.
 *
 * The open-close grammar is `ProfileMenu`'s: outside click and Escape close it, choosing closes
 * it, and the trigger reports state through `aria-expanded`. The label still names where the
 * item will land - that moved from the buttons to the trigger, not out of the interface, because
 * a control whose meaning depends on an invisible selection is the kind people press twice and
 * then undo.
 */
function CreateMenu({
  destinationName,
  disabled,
  onCreate,
  onCreateSmartList,
}: CreateMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // The innermost layer's Escape wins. Both this and the drawer that can wrap this menu
        // (`sidebar-drawer.tsx`) listen for Escape, and without this the drawer's own listener -
        // which sits further out on every keydown's path, on `window` rather than `document` -
        // would close the whole drawer instead of just this menu. Stopping here keeps the event
        // from ever reaching it.
        event.stopPropagation();
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative ml-auto">
      <Button
        variant="ghost"
        className="px-1.5 py-1 text-xs"
        aria-label={`New item in ${destinationName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        disabled={disabled}
      >
        <Icon icon={Plus} size="sm" />
        New
        <Icon icon={ChevronDown} size="sm" />
      </Button>

      {open ? (
        <div
          role="menu"
          aria-label={`New item in ${destinationName}`}
          className="absolute right-0 z-20 mt-1 w-[180px] border border-divider bg-background shadow-md"
        >
          {CREATABLE_KINDS.map((kind) => (
            <button
              key={kind.type}
              type="button"
              role="menuitem"
              aria-label={`New ${kind.type} in ${destinationName}`}
              onClick={() => {
                setOpen(false);
                onCreate(kind.title, kind.type);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-foreground hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon icon={kind.icon} size="sm" />
              {kind.label}
            </button>
          ))}

          {/* The smart lists, below the body kinds under a divider: each creates an item of type
              `query` whose view is the preset's saved query. Offered here because a smart list is
              created, not configured into an existing note - and a person looking for "where do I
              make an Overdue list" looks at New. */}
          <div role="separator" className="border-t border-divider" />
          {SMART_LISTS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitem"
              aria-label={`New ${preset.label} smart list in ${destinationName}`}
              title={preset.detail}
              onClick={() => {
                setOpen(false);
                onCreateSmartList(preset);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-base text-foreground hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon icon={ListFilter} size="sm" />
              {preset.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface TreeBodyProps {
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly onSelect: (itemId: string) => void;
  readonly onOpenBeside: (itemId: string) => void;
  readonly onOpenPinned: (itemId: string) => void;
  readonly canOpenBeside: boolean;
  readonly besideRefusal: BesideRefusal | null;
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;

  /** Deletes an item and starts its undo window. */
  readonly onDeleteItem: (item: TreeItem) => void;
}

function TreeBody(props: TreeBodyProps): ReactNode {
  const { tree } = props;

  if (tree.status === 'loading') {
    return (
      <Text variant="note" tone="muted" className="px-3 py-2">
        Loading the workspace…
      </Text>
    );
  }

  if (tree.status === 'error') {
    return (
      <div role="alert" className="px-3 py-2">
        <Text variant="note" tone="muted" className="mb-2">
          {tree.error}
        </Text>
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
      <Text variant="note" tone="muted" className="px-3 py-2">
        Nothing here yet. &ldquo;New&rdquo; creates the first item.
      </Text>
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
 * **Bounded, deliberately.** Depth is unbounded in principle and the sidebar's width is not - it
 * starts at 264px and can be dragged down to 200 - so the indent cannot be unbounded in practice:
 * nine levels already spend 102px of the width, and a tenth would be taken from the title. Past the bound the indent stops growing and deeper rows share the last
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
  // A selector rather than the whole store, so a row re-renders when its own answer moves and not
  // when somebody keeps an unrelated item three folders away.
  const keptIds = useBookmarksStore((state) => state.keptIds);

  const {
    item,
    depth,
    tree,
    selectedId,
    onSelect,
    onOpenBeside,
    onOpenPinned,
    canOpenBeside,
    besideRefusal,
    dragged,
    setDragged,
    onDeleteItem,
  } = props;

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

    // The keyboard half of a modifier-click. A gesture that only a pointer can make is a feature
    // for only some people - the same objection that gave the moves below their alt-arrows - and
    // Alt is already the modifier this row means business with.
    if (event.key === 'Enter') {
      event.preventDefault();
      if (canOpenBeside) {
        onOpenBeside(item.id);
      } else if (besideRefusal !== null) {
        // A pointer user gets a disabled control whose name explains itself; without this a
        // keyboard user gets silence, which reads as a broken key rather than a full screen.
        announce(BESIDE_REFUSAL_COPY[besideRefusal]);
      }
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

        {/* `max-sm:size-(--control-sm)` on both the button and its placeholder, narrow-scoped:
            below `sm` this is a touch target and 20px (`size-5`) is under WCAG 2.5.8's 24px floor,
            but the two have to grow together or a row without an expand control would sit at a
            different gutter width than one with it.

            `pointer-coarse:size-(--control-sm)` rides alongside it: `group-hover:*` only applies
            under `@media(hover:hover)` (Tailwind v4's `pointer-coarse:` variant maps to
            `@media(pointer:coarse)`), so a touch-capable device *above* `sm` - an iPad in portrait,
            say - would otherwise get neither the hover reveal nor the `max-sm:` override, leaving
            it unreachable rather than merely small. */}
        {expandable ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => {
              void tree.toggle(item.id);
            }}
            className="flex size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm) items-center justify-center text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="sm" />
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm)"
          />
        )}

        <button
          type="button"
          onClick={(event) => {
            // The accelerator everybody already has from a browser and an editor. Gated on the
            // platform's own modifier: Ctrl+click on a Mac is the *secondary* click, so accepting
            // it there would turn every attempt to open a context menu into a new pane.
            if (APPLE ? event.metaKey : event.ctrlKey) {
              // Deliberately not gated here. `openBeside` refuses on its own - it announces the
              // reason and writes nothing - which is the only place the check can live and still
              // be true of every caller. An earlier cut gated the controls instead, and this
              // branch routed around it.
              onOpenBeside(item.id);
              return;
            }
            onSelect(item.id);
          }}
          onDoubleClick={() => {
            onOpenPinned(item.id);
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

        {/* Beside Delete, in the row's own established grammar: revealed on hover, always
            reachable by keyboard - and, below `sm`, always visible and at the 28px control size
            rather than 20px, because touch has no hover to reveal a hidden control with, and a
            control under WCAG 2.5.8's 24px floor is a thumb's width from the row next to it.
            The modifier-click and Alt+Enter above are accelerators for this control rather than
            the whole feature - a gesture only a pointer can make is a feature for only some
            people, and a `title` tooltip is worse than nothing here, because it is read aloud
            after every row while never reaching a touch or keyboard user at all.

            Not rendered at all when the refusal is `'narrow'`: that reason is a fact about this
            viewport, not a transient state of the pane arrangement, and it is true of every row in
            the tree at once. A disabled, ever-present control whose label is a refusal nobody can
            ever act around is worse than no control - on a phone a screen reader would hear it on
            every single row. `'limit'` is the opposite: a temporary state of how many panes happen
            to be open, so it stays visible and disabled, with the explanation, exactly as before. */}
        {besideRefusal === 'narrow' ? null : (
          <button
            type="button"
            disabled={!canOpenBeside}
            aria-label={
              besideRefusal === null
                ? `Open ${item.title || 'Untitled'} beside`
                : `Cannot open ${item.title || 'Untitled'} beside. ${BESIDE_REFUSAL_COPY[besideRefusal]}`
            }
            onClick={() => {
              onOpenBeside(item.id);
            }}
            // `opacity-0`, not `invisible`. `visibility: hidden` takes an element out of the tab
            // order entirely, so `focus-visible:visible` can never fire - nothing can focus it in
            // order to un-hide it. The control was pointer-only, which is the objection it exists to
            // answer. Opacity hides it and keeps it reachable.
            //
            // `pointer-events-none` rides along with that same `opacity-0` regardless of viewport
            // width: an element can be hit-tested while fully transparent, so without this a thumb
            // or pointer landing near the row's edge could trigger a control nothing on screen shows
            // it landed on. The three states that raise the opacity back to 100 - hover, focus-visible,
            // group-hover - restore pointer events with it; `max-sm:` does the same unconditionally,
            // since below `sm` this is never hidden in the first place.
            className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) ${disabledState} ${focusRing}`}
          >
            <Icon icon={Columns2} size="sm" />
          </button>
        )}

        {/* Revealed on hover and on focus like its neighbours, and always visible once the item is
            kept - a star that vanished when the pointer left would mean a reader could not tell
            what they had bookmarked without hovering every row in turn. `BookmarkButton` owns the
            pressed state and the toggle; the classes here are the row's, because only the row knows
            what its controls look like. */}
        <BookmarkButton
          compact
          itemId={item.id}
          title={item.title}
          className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) ${keptIds.has(item.id) ? 'opacity-100 pointer-events-auto' : ''} ${focusRing}`}
        />

        <button
          type="button"
          aria-label={`Delete ${item.title}`}
          onClick={() => {
            // Immediate, on purpose - see `requestDelete` on `app-shell.tsx` for why a toast
            // with Undo replaced the `globalThis.confirm()` this control used to sit behind. The
            // control is revealed on hover and sits a few pixels from the one that opens the
            // item, which is exactly the situation Undo (rather than a slower "are you sure") is
            // meant to answer.
            onDeleteItem(item);
          }}
          // `opacity-0` for the same reason the control above it uses one: `visibility: hidden`
          // takes an element out of the tab order, so this was keyboard-unreachable - and of the
          // two controls in this row it is the destructive one. `pointer-events-none` and the
          // narrow-scoped sizing and always-visible state follow the same reasoning as that
          // control's own comment, as does the `pointer-coarse:` trio beside it: `group-hover:*`
          // needs `@media(hover:hover)`, so a touch-capable device above `sm` gets neither that nor
          // the `max-sm:` override without it.
          className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) ${focusRing}`}
        >
          <Icon icon={Trash2} size="sm" />
        </button>
      </div>

      {expanded ? (
        <ul role="group">
          {tree.isLoadingChildren(item.id) && children.length === 0 ? (
            <Text
              variant="note"
              as="li"
              tone="muted"
              className={`py-1 ${indentAt(CHILD_NOTICE_INDENT, depth)}`}
            >
              Loading…
            </Text>
          ) : children.length === 0 ? (
            <Text
              variant="note"
              as="li"
              tone="muted"
              className={`py-1 ${indentAt(CHILD_NOTICE_INDENT, depth)}`}
            >
              Empty
            </Text>
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
