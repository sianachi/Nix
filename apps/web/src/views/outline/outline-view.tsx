import { Button, Icon, Input, Text, cn, focusRing } from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  IndentDecrease,
  IndentIncrease,
  Lock,
  Plus,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { EmptyPanel } from '../../components/states/status-panels';
import { sortItems, type Item, type View } from '../core/container-model';
import type { ContainerData } from '../core/use-container';
import { onItemChildrenChanged } from '../../lib/item-children-changed';
import { ContainerNotices, resolveLoadState } from '../core/view-chrome';
import {
  describeOutlineRefusal,
  isLockedRead,
  useOutlineSource,
  type OutlineSource,
} from './outline-source';

/**
 * The outline (plan 3.8): the subtree as a collapsible tree of titles, reshaped from the keyboard.
 *
 * **The one view that edits structure.** Every other kind writes properties; this one adds items,
 * reparents them and reorders them, and it does all three through the item create and move
 * endpoints the sidebar already uses (`outline-source.ts`). So a lock, an item that accepts no
 * children and a move into its own subtree are refused by the same server code, and the refusal is
 * said on the row it was about rather than in a banner somebody has to connect back to it.
 *
 * **A real tree.** `role="tree"` with `treeitem`s that carry their level, position and expanded
 * state, and one roving tab stop: Up and Down move between visible rows, Right opens a row (its
 * children are read on the first open, never before) and Left closes it or steps to its parent.
 * Tab and Shift+Tab reparent the focused row, which is what an outliner's keyboard is for - so
 * Escape releases the next Tab, and that is how a keyboard leaves the tree.
 *
 * **Not only a keyboard.** The toolbar above the tree does each structural edit to the row last
 * focused, for a pointer and for a phone, which has no Tab key at all.
 */

export interface OutlineViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export function OutlineView(props: OutlineViewProps): ReactNode {
  const source = useOutlineSource();
  return <OutlineTree {...props} source={source} />;
}

/** The outline over any source; `OutlineView` supplies the real one. */
export interface OutlineTreeProps extends OutlineViewProps {
  readonly source: OutlineSource;
}

/** One visible row: the item, how deep it sits and where it is among its siblings. */
interface OutlineRow {
  readonly item: Item;
  readonly level: number;
  readonly parentId: string | null;
  readonly siblings: readonly Item[];
  readonly index: number;
}

/** Where the "new item" field sits: under a parent, after a sibling (null for first). */
interface Draft {
  readonly parentId: string | null;
  readonly afterId: string | null;
  readonly level: number;
}

/** A sentence about one row - a refused move, a locked branch - shown under that row. */
interface RowNote {
  readonly itemId: string;
  readonly text: string;
}

export function OutlineTree(props: OutlineTreeProps): ReactNode {
  const { container, view, onOpen, source } = props;
  const rootId = container.itemId;

  const [nested, setNested] = useState<ReadonlyMap<string, readonly Item[]>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [locked, setLocked] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<RowNote | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const releaseTab = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);

  // Focus follows the row the last edit was about, once the re-read that moved it has rendered. A
  // ref rather than state: it is an instruction to the next render, not something to draw.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const element = rowRefs.current.get(target);
    if (element !== undefined) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  // Somebody else's edit - the sidebar, another tab of this app, a pet - can change a level this
  // outline has already read. Each opened level is re-read when its children are said to change;
  // the top level is the container's own and reloads itself.
  const nestedRef = useRef(nested);
  useEffect(() => {
    nestedRef.current = nested;
  }, [nested]);
  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        const parents =
          detail.parentId === null ? [...nestedRef.current.keys()] : [detail.parentId];
        for (const parentId of parents) {
          if (!nestedRef.current.has(parentId)) continue;
          void source
            .list(parentId)
            .then((children) => {
              setNested((current) =>
                new Map(current).set(parentId, sortItems(children, null, false)),
              );
            })
            .catch(() => undefined);
        }
      }),
    [source],
  );
  const captionId = useId();

  const loadState = resolveLoadState(container, 'this outline');
  if (loadState !== null) return loadState;

  const roots = sortItems(container.children, null, false);
  const childrenOf = (parentId: string | null): readonly Item[] =>
    parentId === rootId ? roots : parentId === null ? [] : (nested.get(parentId) ?? []);

  const rows: OutlineRow[] = [];
  const walk = (parentId: string | null, level: number): void => {
    const siblings = childrenOf(parentId);
    siblings.forEach((item, index) => {
      rows.push({ item, level, parentId, siblings, index });
      if (expanded.has(item.id)) walk(item.id, level + 1);
    });
  };
  walk(rootId, 1);

  const activeId =
    focusedId !== null && rows.some((row) => row.item.id === focusedId)
      ? focusedId
      : (rows[0]?.item.id ?? null);
  const activeRow = rows.find((row) => row.item.id === activeId) ?? null;

  /** Re-reads one parent's children: the container's own for the top level, a read otherwise. */
  async function refresh(parentId: string | null): Promise<void> {
    if (parentId === rootId) {
      await container.reload();
      return;
    }
    if (parentId === null) return;
    const children = await source.list(parentId);
    setNested((current) => new Map(current).set(parentId, sortItems(children, null, false)));
  }

  async function open(item: Item): Promise<void> {
    setExpanded((current) => new Set(current).add(item.id));
    if (nested.has(item.id)) return;
    setLoading((current) => new Set(current).add(item.id));
    try {
      const children = await source.list(item.id);
      setNested((current) => new Map(current).set(item.id, sortItems(children, null, false)));
      setLocked((current) => without(current, item.id));
    } catch (reason) {
      setExpanded((current) => without(current, item.id));
      if (isLockedRead(reason)) {
        setLocked((current) => new Set(current).add(item.id));
        setNote({
          itemId: item.id,
          text: 'This is locked. Unlock it from its own page to see inside.',
        });
      } else {
        setNote({ itemId: item.id, text: describeOutlineRefusal(reason) });
      }
    } finally {
      setLoading((current) => without(current, item.id));
    }
  }

  function close(item: Item): void {
    setExpanded((current) => without(current, item.id));
  }

  /**
   * One structural edit: the move, then a re-read of every parent it touched, with focus kept on
   * the moved row. A refusal is said under the row and nothing on screen moves.
   */
  async function move(
    row: OutlineRow,
    parentId: string | null,
    afterId: string | null,
  ): Promise<boolean> {
    setNote(null);
    setBusy(true);
    try {
      try {
        await source.move(row.item.id, row.parentId, parentId, afterId);
      } catch (reason) {
        setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
        return false;
      }
      pendingFocus.current = row.item.id;
      // The move happened; a failed re-read is a different sentence from a refused move, because
      // retrying the move would move it again.
      try {
        await Promise.all([...new Set([row.parentId, parentId])].map((parent) => refresh(parent)));
      } catch {
        setNote({
          itemId: row.item.id,
          text: 'Moved, but this outline could not be re-read. Reload the page to see where it is now.',
        });
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function indent(row: OutlineRow): Promise<void> {
    const above = row.siblings[row.index - 1];
    if (above === undefined) {
      setNote({ itemId: row.item.id, text: 'There is nothing above this to move it into.' });
      return;
    }
    if (above.noChildren === true) {
      setNote({
        itemId: row.item.id,
        text: `"${titleOf(above)}" does not accept new children.`,
      });
      return;
    }
    // Last among the new parent's children, which means knowing them: read them first if the row
    // above has never been opened, rather than guessing "first" and landing it out of order.
    let children = nested.get(above.id);
    if (children === undefined && above.hasChildren) {
      try {
        children = sortItems(await source.list(above.id), null, false);
      } catch (reason) {
        setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
        return;
      }
    }
    const last = children?.[children.length - 1];
    if (await move(row, above.id, last?.id ?? null)) {
      setExpanded((current) => new Set(current).add(above.id));
    }
  }

  async function outdent(row: OutlineRow): Promise<void> {
    if (row.parentId === rootId || row.parentId === null) {
      setNote({ itemId: row.item.id, text: 'This is already at the top of this outline.' });
      return;
    }
    const parentRow = rows.find((candidate) => candidate.item.id === row.parentId);
    if (parentRow === undefined) return;
    await move(row, parentRow.parentId, parentRow.item.id);
  }

  function openItem(row: OutlineRow | null): void {
    if (row !== null) onOpen(row.item.id);
  }

  async function reorder(row: OutlineRow, by: -1 | 1): Promise<void> {
    if (by === -1) {
      if (row.index === 0) return;
      const before = row.siblings[row.index - 2];
      await move(row, row.parentId, before?.id ?? null);
      return;
    }
    const after = row.siblings[row.index + 1];
    if (after === undefined) return;
    await move(row, row.parentId, after.id);
  }

  /** Makes a sibling from the draft field, then keeps the field open after it for the next one. */
  async function add(title: string, at: Draft): Promise<string | null> {
    setNote(null);
    let created: Item;
    try {
      created = await source.create(at.parentId, title);
    } catch (reason) {
      // Nothing was made, so the name goes back into the field for another go.
      return describeOutlineRefusal(reason);
    }
    // From here the item exists. Whatever else fails, the draft moves past it and the name is not
    // put back, so a retry can never make it twice.
    const siblings = childrenOf(at.parentId);
    const last = siblings[siblings.length - 1];
    let placementRefused: string | null = null;
    // A create lands last among its siblings; only a sibling added mid-list needs a move.
    if (at.afterId !== null && at.afterId !== last?.id) {
      try {
        await source.move(created.id, at.parentId, at.parentId, at.afterId);
      } catch (reason) {
        placementRefused = `Added at the end instead: ${describeOutlineRefusal(reason)}`;
      }
    }
    try {
      await refresh(at.parentId);
    } catch {
      placementRefused ??= 'Added, but this outline could not be re-read. Reload to see it.';
    }
    setDraft({ ...at, afterId: created.id });
    setFocusedId(created.id);
    if (placementRefused !== null) setNote({ itemId: created.id, text: placementRefused });
    return null;
  }

  function focusRow(id: string | undefined): void {
    if (id === undefined) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: OutlineRow): void {
    const modifier = event.metaKey || event.ctrlKey;
    const position = rows.indexOf(row);

    if (event.key === 'Tab') {
      if (releaseTab.current) {
        releaseTab.current = false;
        return;
      }
      event.preventDefault();
      if (busy) return;
      void (event.shiftKey ? outdent(row) : indent(row));
      return;
    }
    releaseTab.current = false;

    // The sidebar tree's bindings work here too, so the hands that move rows there move them here.
    if (event.altKey && !modifier) {
      const action: Record<string, (() => void) | undefined> = {
        ArrowUp: () => void reorder(row, -1),
        ArrowDown: () => void reorder(row, 1),
        ArrowRight: () => void indent(row),
        ArrowLeft: () => void outdent(row),
        Enter: () => {
          onOpen(row.item.id);
        },
      };
      const run = action[event.key];
      if (run !== undefined) {
        event.preventDefault();
        if (!busy || event.key === 'Enter') run();
        return;
      }
    }

    switch (event.key) {
      case 'Escape':
        // The way out: the next Tab leaves the tree instead of indenting. Claimed, so the same
        // press does not also leave Zen mode or close whatever the outline sits in.
        event.preventDefault();
        event.stopPropagation();
        releaseTab.current = true;
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (modifier) {
          if (!busy) void reorder(row, 1);
        } else {
          focusRow(rows[position + 1]?.item.id);
        }
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (modifier) {
          if (!busy) void reorder(row, -1);
        } else {
          focusRow(rows[position - 1]?.item.id);
        }
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (!row.item.hasChildren) return;
        if (expanded.has(row.item.id)) {
          focusRow(rows[position + 1]?.item.id);
        } else {
          void open(row.item);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (expanded.has(row.item.id)) {
          close(row.item);
        } else {
          focusRow(row.parentId ?? undefined);
        }
        return;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0]?.item.id);
        return;
      case 'End':
        event.preventDefault();
        focusRow(rows[rows.length - 1]?.item.id);
        return;
      case 'Enter':
        event.preventDefault();
        if (modifier) {
          onOpen(row.item.id);
        } else {
          setDraft({ parentId: row.parentId, afterId: row.item.id, level: row.level });
        }
        return;
      default:
        return;
    }
  }

  // The field for a new sibling goes after the whole of the row it follows - after its open
  // children too - because that is where the new item will sit once it exists.
  const draftAnchor = ((): number => {
    if (draft?.afterId == null) return -1;
    const start = rows.findIndex(
      (row) => row.item.id === draft.afterId && row.parentId === draft.parentId,
    );
    if (start === -1) return -1;
    let end = start;
    const level = rows[start]?.level ?? 0;
    while ((rows[end + 1]?.level ?? 0) > level) end += 1;
    return end;
  })();

  const draftField =
    draft === null ? null : (
      <DraftField
        key={`${draft.parentId ?? 'root'}:${draft.afterId ?? 'first'}`}
        level={draft.level}
        onSubmit={(title) => add(title, draft)}
        onCancel={() => {
          const back = draft.afterId;
          setDraft(null);
          if (back !== null) {
            pendingFocus.current = back;
            setFocusedId(back);
          }
        }}
      />
    );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <ContainerNotices container={container} subject="this outline" />

      <OutlineToolbar
        row={activeRow}
        busy={busy}
        onOpen={() => {
          openItem(activeRow);
        }}
        onAdd={() => {
          if (activeRow === null) {
            setDraft({ parentId: rootId, afterId: null, level: 1 });
          } else {
            setDraft({
              parentId: activeRow.parentId,
              afterId: activeRow.item.id,
              level: activeRow.level,
            });
          }
        }}
        onIndent={() => {
          if (activeRow !== null) void indent(activeRow);
        }}
        onOutdent={() => {
          if (activeRow !== null) void outdent(activeRow);
        }}
        onUp={() => {
          if (activeRow !== null) void reorder(activeRow, -1);
        }}
        onDown={() => {
          if (activeRow !== null) void reorder(activeRow, 1);
        }}
      />

      <div id={captionId}>
        <Text as="p" variant="caption" tone="muted" className="pointer-coarse:hidden">
          Enter adds an item below. Tab and Shift+Tab, or Alt with Right and Left, indent and
          outdent. Ctrl or Cmd with Up and Down reorders, and with Enter opens. Escape, then Tab,
          leaves the outline.
        </Text>
        <Text as="p" variant="caption" tone="muted" className="hidden pointer-coarse:block">
          Tap a row to choose it, then use the buttons above to add, indent, move or open it.
        </Text>
      </div>

      {rows.length === 0 && draft === null ? (
        <EmptyPanel
          title="Nothing in this outline yet"
          detail="Add the first item, then press Enter for the next one and Tab to tuck it under."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setDraft({ parentId: rootId, afterId: null, level: 1 });
              }}
            >
              Add the first item
            </Button>
          }
        />
      ) : (
        <div
          role="tree"
          aria-label={view.name}
          aria-describedby={captionId}
          aria-busy={busy}
          className="flex flex-col"
        >
          {draft !== null && draft.afterId === null ? draftField : null}
          {rows.map((row, position) => {
            const id = row.item.id;
            const isOpen = expanded.has(id);
            // The top level of a truncated container is a sample, so its size is not claimed.
            const sizeKnown = !(row.level === 1 && container.truncated);
            return (
              <div key={id} role="none" className="flex flex-col">
                <div
                  ref={(element) => {
                    if (element === null) rowRefs.current.delete(id);
                    else rowRefs.current.set(id, element);
                  }}
                  role="treeitem"
                  aria-level={row.level}
                  aria-setsize={sizeKnown ? row.siblings.length : -1}
                  aria-posinset={row.index + 1}
                  aria-selected={id === activeId}
                  {...(row.item.hasChildren ? { 'aria-expanded': isOpen } : {})}
                  tabIndex={id === activeId ? 0 : -1}
                  onFocus={() => {
                    setFocusedId(id);
                  }}
                  onKeyDown={(event) => {
                    onRowKeyDown(event, row);
                  }}
                  onDoubleClick={() => {
                    onOpen(id);
                  }}
                  className={cn(
                    'flex min-h-(--control-sm) flex-wrap items-center gap-1 rounded-sm py-1 pointer-coarse:min-h-(--control-lg)',
                    id === activeId ? 'bg-foreground/7' : '',
                    focusRing,
                  )}
                  style={{ paddingInlineStart: `${String((row.level - 1) * 1.5)}rem` }} // design-token-exempt: indentation grows with the tree's depth, which is data rather than a design value
                >
                  {/* The disclosure is a pointer convenience over what Right and Left already do,
                      so it is not a second tab stop inside the row. */}
                  <span
                    aria-hidden="true"
                    onClick={() => {
                      if (!row.item.hasChildren) return;
                      if (isOpen) close(row.item);
                      else void open(row.item);
                    }}
                    className="inline-flex size-(--control-sm) shrink-0 items-center justify-center text-muted pointer-coarse:size-(--control-lg)"
                  >
                    {row.item.hasChildren ? (
                      <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" />
                    ) : null}
                  </span>
                  <Text as="span" variant="body" className="min-w-0 flex-1">
                    {titleOf(row.item)}
                  </Text>
                  {locked.has(id) ? (
                    <>
                      <Icon icon={Lock} size="sm" className="text-muted" />
                      <span className="sr-only">, locked</span>
                    </>
                  ) : null}
                  {loading.has(id) ? (
                    <Text as="span" variant="caption" tone="muted">
                      Loading
                    </Text>
                  ) : null}
                  {/* Inside the row it is about, so the tree owns only rows and the new-item
                      group, and a screen reader hears the note as part of the row. */}
                  {note !== null && note.itemId === id ? (
                    <Text
                      as="span"
                      variant="caption"
                      tone="accent"
                      role="alert"
                      className="basis-full"
                    >
                      {note.text}
                    </Text>
                  ) : null}
                </div>
                {position === draftAnchor ? draftField : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function titleOf(item: Item): string {
  return item.title.length > 0 ? item.title : 'Untitled';
}

function without(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

interface OutlineToolbarProps {
  readonly row: OutlineRow | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onAdd: () => void;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly onUp: () => void;
  readonly onDown: () => void;
}

/** The structural edits as buttons, acting on the row last focused - a phone has no Tab key. */
function OutlineToolbar(props: OutlineToolbarProps): ReactNode {
  const { row, busy, onOpen, onAdd, onIndent, onOutdent, onUp, onDown } = props;
  const name = row === null ? '' : ` "${titleOf(row.item)}"`;
  const disabled = row === null || busy;
  return (
    <div role="group" aria-label="Outline actions" className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" onClick={onOpen} disabled={row === null}>
        <Icon icon={ExternalLink} size="sm" />
        Open
      </Button>
      <Button variant="ghost" onClick={onAdd} disabled={busy}>
        <Icon icon={Plus} size="sm" />
        Add item
      </Button>
      <Button variant="icon" aria-label={`Indent${name}`} onClick={onIndent} disabled={disabled}>
        <Icon icon={IndentIncrease} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Outdent${name}`} onClick={onOutdent} disabled={disabled}>
        <Icon icon={IndentDecrease} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Move${name} up`} onClick={onUp} disabled={disabled}>
        <Icon icon={ArrowUp} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Move${name} down`} onClick={onDown} disabled={disabled}>
        <Icon icon={ArrowDown} size="sm" />
      </Button>
      {/* Which row the buttons act on, said where they are: the highlight alone is easy to lose. */}
      <Text as="span" variant="caption" tone="muted" truncate className="min-w-0">
        {busy ? 'Saving…' : row === null ? 'No row chosen' : `Acting on “${titleOf(row.item)}”`}
      </Text>
    </div>
  );
}

/**
 * The field a new item is named in. Never disabled while it saves, so focus stays for the next
 * name; a refused add puts the name back and says why.
 */
function DraftField({
  level,
  onSubmit,
  onCancel,
}: {
  readonly level: number;
  readonly onSubmit: (title: string) => Promise<string | null>;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  return (
    // A row of the tree in its own right - the row being made - so the tree owns only tree items
    // while the field sits where the new item will appear.
    <div
      role="treeitem"
      tabIndex={-1}
      aria-label="New item"
      aria-level={level}
      aria-selected={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const named = title.trim();
          if (named.length === 0) return;
          setTitle('');
          setRefusal(null);
          void onSubmit(named).then((reason) => {
            if (reason !== null) {
              setRefusal(reason);
              setTitle(named);
            }
          });
        }}
        className="flex flex-col gap-1 py-1"
        style={{ paddingInlineStart: `${String((level - 1) * 1.5 + 2)}rem` }} // design-token-exempt: indentation grows with the tree's depth, which is data rather than a design value
      >
        <Input
          ref={fieldRef}
          aria-label="New item"
          placeholder="Name the new item"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        {refusal === null ? null : (
          <Text as="p" variant="caption" tone="accent" role="alert">
            {refusal}
          </Text>
        )}
      </form>
    </div>
  );
}
