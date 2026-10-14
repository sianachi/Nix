import { useNarrowViewport } from '../../layout/viewport';
import {
  Button,
  Checkbox,
  ContextMenu,
  Icon,
  Text,
  Table,
  Select,
  cn,
  focusRing,
  type ContextMenuTargetProps,
  type MenuEntry,
  type TableColumn,
  type TableRowDrag,
  type TableSort,
} from '@nix/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { dropRefusal } from '../../items/bulk-move';
import { useOptionalItemCommands } from '../../items/item-commands-context';

import { PartialNotice } from '../../components/states/status-panels';

import { isKnownPropertyType } from '../../properties/property-input';
import { TITLE_COLUMN_KEY, resolveConfiguredColumns } from '../core/columns';
import {
  readPropertyText,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
  type View,
  type ViewFilterRule,
} from '../core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import { suggestSourceOf } from '../suggest/suggest-source';
import { useItemContextActions } from '../core/use-item-context-actions';
import { resetColumnWidth, setColumnWidth, useColumnWidths } from '../core/column-widths';
import { ShownItems, useOptionalItemSelection } from '../core/item-selection-context';
import { useClickSelects } from '../core/item-open-click';
import { rowGestures } from '../core/use-item-selection';
import { cellFor, isCellMoveKey, moveFocusedCell } from './cell-nav';
import { ListCell } from './list-cell';
import type { ContainerData } from '../core/use-container';
import { drawable, useViewChrome, ViewSettingsLink } from '../core/view-chrome';
import { viewConfigureHref } from '../core/view-configure-route';
import { capabilitiesOf } from '../core/view-capabilities';
import { useViewState, type SortDirection } from '../core/view-state';
import { useVirtualWindow } from '../core/use-virtual-window';
import { virtualSpacers } from '../core/virtual-window';
import {
  describeAxisProblem,
  groupItems,
  resolveViewAxis,
  type AxisGroup,
} from '../core/view-axis';

const VIRTUALIZATION_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT = 45;

/**
 * The list view: a container's children as a table, edited in place.
 *
 * The plainest of the three views and the one every container falls back to, so it is also the one
 * that has to be right about the least interesting things - what the columns are, what order the
 * rows are in, and above all what it says when there are no rows. Those five answers are not
 * decided here: they are the shared view chrome, which the board and the calendar also ask, because
 * four copies of one decision is four chances to drop the branch nobody meets while building.
 *
 * **Every cell is a control, always drawn as one.** Not click-to-edit: that needs a focus transfer
 * effect of its own, and it hides from a screen reader the one fact the table is trying to convey,
 * which is that these values can be changed. The cost is a tab stop per cell - kept, deliberately:
 * goal 3.8 adds Alt+Arrow cell-to-cell movement (`./cell-nav.ts`) rather than roving tabindex, so
 * this table never trades a long tab order for the focus-restoration problem a roving tabindex
 * would reopen on every re-sort, optimistic update and refusal rollback (see the note below).
 *
 * **Plain table semantics.** A real `<table>` with `<th scope="row">` row headers, not `role="grid"`
 * with a roving tabindex. A roving tabindex is focus state with no source - it cannot come from the
 * URL - so it would be local state plus an effect moving DOM focus, and focus jumping on a re-sort,
 * on an optimistic update or on a refusal rollback is worse than a long tab order.
 *
 * **The sort is not held here.** It lives in the URL, because a sorted table that cannot be linked
 * or restored by the back button is a table somebody has to re-sort every time they arrive. This
 * component reads the sort out of `useViewState` and writes a header click back to it; between
 * those two the state is the address bar's, and React re-renders because the address changed.
 */

/** A stable empty rule set for the container that defines no view, so the filter memo holds. */
const NO_RULES: readonly ViewFilterRule[] = [];

export interface ListViewProps {
  readonly container: ContainerData;

  /** The view being rendered, or null for a container that defines none. */
  readonly view: View | null;

  /**
   * Opens one item. A callback rather than a router import: which route an item opens at is the
   * hosting page's business, and a view that navigated on its own could not be put in a dialog, a
   * split pane, or a story.
   */
  readonly onOpen: (itemId: string) => void;
}

export function ListView(props: ListViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const narrow = useNarrowViewport();
  const viewState = useViewState();
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());
  const itemActions = useItemContextActions(onOpen);
  const rowContextMenu = (item: Item): MenuEntry[] => itemActions(item.id, item.title);
  const selection = useOptionalItemSelection();
  const clickSelects = useClickSelects();
  const commands = useOptionalItemCommands();
  // The rows being dragged and the row a drop would land on; null when nothing is mid-drag.
  const [dragging, setDragging] = useState<readonly string[] | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const viewId = view?.id ?? null;
  const columnWidths = useColumnWidths(viewId);

  // Which sections are folded away. Seeded from the view's stored `collapsedGroups` (ADR-0054) and
  // then held here: folding a section is somebody reading, not somebody rearranging the view for
  // everyone, so it is not written back to the shared view on every click.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(view?.collapsedGroups ?? []),
  );

  // The URL wins, the stored view is the starting point. A view configured to sort by owner is
  // what somebody arriving with no sort in the address should see; the moment they click a header
  // the address is the more specific statement and this falls through to it.
  const sortBy = viewState.sortBy ?? view?.sortBy ?? null;
  const direction: SortDirection =
    viewState.sortBy !== null
      ? viewState.direction
      : view?.sortDescending === true
        ? 'descending'
        : 'ascending';

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this list',
    // A list needs nothing configured to be drawable: it has titles to show even with no schema,
    // which is exactly why it is what every container falls back to.
    drawable: drawable(null),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as rows.',
    emptyAction: <CreateItemControl label="Add an item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      // Says how many are hidden, because "no items match" leaves open the possibility that the
      // item was empty all along, and the count is the proof that it was not.
      detail: hiddenByFilters(total),
    }),
    savedRules: view?.filters ?? NO_RULES,
    view: view ?? null,
    sortBy,
    descending: direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  function write(itemId: string, key: string, value: PropertyValue): Promise<string | null> {
    return container.setProperties(itemId, { [key]: value });
  }

  const refusalStore: CellRefusalStore = {
    read: (itemId, key) => refusals.get(cellRefusalKey(itemId, key)) ?? null,
    write: (itemId, key, refusal) => {
      setRefusals((current) => {
        const next = new Map(current);
        const cacheKey = cellRefusalKey(itemId, key);
        if (refusal === null) {
          next.delete(cacheKey);
        } else {
          next.set(cacheKey, refusal);
        }
        return next;
      });
    },
  };
  const orderIds = chrome.items.map((item) => item.id);
  const besideOf = selection?.openBeside;
  const gesturesFor = (item: Item): RowGestures =>
    rowGestures(
      selection,
      item.id,
      orderIds,
      () => {
        onOpen(item.id);
      },
      besideOf === undefined
        ? undefined
        : () => {
            besideOf(item.id);
          },
      clickSelects,
    );
  // A touch long-press starts a selection; once one exists it opens the row menu as before.
  const longPress = (item: Item): boolean => {
    if (selection === null || selection.selected.size > 0) return false;
    selection.toggle(item.id, orderIds);
    return true;
  };
  // Dropping a row on another puts it inside (capabilities `drag: 'parent'`). A selected row drags
  // the whole selection. An invalid target is still a drop target so the refusal is said, but it is
  // never outlined as one. The keyboard path is "Move to…" in the row menu and the selection tray:
  // Alt+Arrow here already moves between cells.
  const rowDrag = (item: Item): TableRowDrag => {
    const alone = dragging?.length === 1 && dragging[0] === item.id;
    return {
      draggable: true,
      onDragStart: (event) => {
        const ids = selection?.selected.has(item.id) === true ? [...selection.selected] : [item.id];
        setDragging(ids);
        event.dataTransfer.effectAllowed = 'move';
        // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
        event.dataTransfer.setData('text/plain', ids.join(','));
      },
      onDragOver: (event) => {
        if (dragging === null || alone || commands === null) return;
        event.preventDefault();
        setOverId(dropRefusal(dragging, item.id, commands.tree.find) === null ? item.id : null);
      },
      onDragLeave: () => {
        setOverId(null);
      },
      onDragEnd: () => {
        setDragging(null);
        setOverId(null);
      },
      onDrop: (event) => {
        event.preventDefault();
        const ids = dragging;
        setDragging(null);
        setOverId(null);
        if (ids === null || alone || commands === null) return;
        // Rows that left this list are gone from the next read, with the destination named.
        void commands
          .dropItems(ids, item.id)
          .then((moved) => (moved.length > 0 ? container.reload() : undefined));
      },
      dropTarget: overId === item.id,
    };
  };
  const rowSelection: RowSelection = {
    selected: (item) => selection?.selected.has(item.id) === true,
    longPress: selection === null ? undefined : longPress,
    drag:
      commands === null || container.locked || !capabilitiesOf('list').move ? undefined : rowDrag,
  };
  const columns = [
    // A box per row while the container selects (requirement 7): a plain toggle, Shift extends.
    // It sits in a fixed gutter and is only drawn on row hover or focus until something is selected,
    // so the 95% of visits that never select see no column of boxes - and nothing shifts when one
    // appears.
    ...(selection === null
      ? []
      : [
          {
            key: SELECT_COLUMN_KEY,
            header: 'Select',
            gutter: true,
            cell: (item: Item) => (
              <span
                className={cn(
                  'flex',
                  selection.selected.size === 0 &&
                    'opacity-0 focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
                )}
              >
                <Checkbox
                  aria-label={`Select ${item.title || 'Untitled'}`}
                  checked={selection.selected.has(item.id)}
                  onClick={(event) => {
                    selection.toggle(item.id, orderIds, event.shiftKey);
                  }}
                  onChange={() => undefined}
                />
              </span>
            ),
          } satisfies TableColumn<Item>,
        ]),
    ...buildColumns(view, container.schema, gesturesFor, write, refusalStore),
  ];
  const sort = sortBy === null ? undefined : { columnKey: sortBy, direction };
  const onSortChange = (next: TableSort): void => {
    viewState.setSort(next.columnKey, next.direction);
  };

  // Sections (plan 3.3). A grouping that cannot be resolved does not cost the list its rows: the
  // list is what every container falls back to, so it draws flat and says why the headings are
  // missing rather than refusing to draw at all, which is what a board does without its columns.
  const settingsHref = view === null ? null : viewConfigureHref(container.itemId, view);
  const sectioning = resolveViewAxis(container.schema?.properties ?? [], view?.groupBy, {
    allowType: true,
  });
  const sections =
    sectioning.kind === 'ready'
      ? groupItems(sectioning.axis, chrome.items, view?.groupOrder ?? [])
      : null;
  const sectionNotice =
    sectioning.kind === 'missing' || sectioning.kind === 'wrongType' ? (
      <PartialNotice
        pending={`This list is shown without sections. ${describeAxisProblem(sectioning, 'sections')}`}
        {...(settingsHref === null ? {} : { action: <ViewSettingsLink href={settingsHref} /> })}
      />
    ) : null;
  const toggleSection = (group: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };
  const rowsFor = (items: readonly Item[], caption: string, showSort: boolean): ReactNode =>
    narrow ? (
      <MobileListRows
        items={items}
        columns={columns}
        sort={sort}
        onSortChange={onSortChange}
        rowContextMenu={rowContextMenu}
        rowSelection={rowSelection}
        caption={caption}
        showSort={showSort}
      />
    ) : (
      <ListRows
        items={items}
        columns={columns}
        sort={sort}
        onSortChange={onSortChange}
        rowContextMenu={rowContextMenu}
        rowSelection={rowSelection}
        caption={caption}
        widths={
          viewId === null
            ? undefined
            : {
                columnWidths,
                onColumnResize: (columnKey, width) => {
                  setColumnWidth(viewId, columnKey, width);
                },
                onColumnWidthReset: (columnKey) => {
                  resetColumnWidth(viewId, columnKey);
                },
              }
        }
      />
    );

  return (
    // The table's own horizontal scroller. A `w-full` table is laid out `auto`, so it cannot render
    // narrower than its min-content width - enough property columns and it paints straight past a
    // `min-w-0` parent. Now that the pane scrolls only vertically, this is the sole owner of the
    // wide axis.
    //
    // Justification: this div is not itself interactive - it only delegates a keydown listener
    // that catches Alt+Arrow bubbling up from its own focusable descendants (the real per-cell
    // controls, see `cell-nav.ts`). A role or tabIndex here would make the div itself a tab stop
    // or a widget, which is exactly what goal 3.8's ruling says not to build.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="min-w-0 overflow-x-auto"
      onKeyDown={(event) => {
        // Alt is the gate: a plain arrow, Home or End belongs to whatever control is focused (a
        // caret, a date stepper, a select, a checkbox) and must reach it untouched - see
        // `cell-nav.ts` for why this table cannot use the spreadsheet's own arrow-key ladder.
        if (!event.altKey || event.ctrlKey || event.metaKey || !isCellMoveKey(event.key)) {
          return;
        }
        if (!(event.target instanceof Element)) {
          return;
        }
        const cell = cellFor(event.target);
        if (cell === null) {
          // Not one of the list's own cells (a sort header, the "Add an item" control): this
          // shortcut has nothing to say here, so the key is left alone rather than claimed.
          return;
        }
        // Claimed once it is known to be ours, whether or not a destination exists - an edge does
        // nothing to the table, but the keystroke must still not fall through to the browser's own
        // Alt+Arrow history navigation or a native `<select>`'s Alt+ArrowDown.
        event.preventDefault();
        moveFocusedCell(cell, event.key);
      }}
    >
      {selection === null ? null : <ShownItems ids={orderIds} />}
      {chrome.notice}
      {sectionNotice}

      {sections === null ? (
        rowsFor(chrome.items, ITEMS_CAPTION, true)
      ) : (
        <>
          {narrow ? (
            <MobileSortBar
              columns={columns.filter((column) => column.key !== SELECT_COLUMN_KEY)}
              sort={sort}
              onSortChange={onSortChange}
            />
          ) : null}
          <ListSections
            sections={sections}
            collapsed={collapsed}
            onToggle={toggleSection}
            renderRows={(section) => rowsFor(section.items, section.label, false)}
          />
        </>
      )}

      {/* Below the table rather than as a last row. `<Table>` has no footer seam, and a row would
          enter the row-header inventory that eleven assertions compare against exactly - so it
          would be a create affordance that broke tests about columns. */}
      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        suggest={suggestSourceOf(container, onOpen)}
        className="mt-2"
      />
    </div>
  );
}

/** What an ungrouped list's table is called; a section's table is called after its heading. */
const ITEMS_CAPTION = 'Items in this one';

/** The selection column's key; never a property, so it cannot collide with one. */
const SELECT_COLUMN_KEY = '\u0000select';

interface ListSectionsProps {
  readonly sections: readonly AxisGroup[];
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (group: string) => void;
  readonly renderRows: (section: AxisGroup) => ReactNode;
}

/**
 * A grouped list: one heading per section, each with its count and a disclosure that folds it.
 *
 * **The heading is a real heading holding a real button.** The heading is what a screen reader's
 * heading list offers to jump between, and the button inside it is what folds the section - with
 * `aria-expanded` saying which state it is in and `aria-controls` naming what it hides - the
 * disclosure pattern rather than a clickable `<h3>`, which a keyboard cannot reach.
 *
 * Each section's rows are the list's own table, captioned with the section's name, so row headers,
 * in-place cells, context menus and windowing past a hundred rows behave exactly as an ungrouped
 * list's do: the sections reuse the rows rather than drawing a second kind of row.
 */
function ListSections(props: ListSectionsProps): ReactNode {
  const { sections, collapsed, onToggle, renderRows } = props;
  const baseId = useId();

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section, index) => {
        const open = !collapsed.has(section.group);
        const bodyId = `${baseId}-section-${String(index)}`;
        return (
          <section key={section.group} className="flex flex-col gap-2">
            <Text as="h3" variant="h6">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => {
                  onToggle(section.group);
                }}
                className={cn(
                  'flex w-full items-center gap-2 text-left pointer-coarse:min-h-(--control-lg)',
                  focusRing,
                )}
              >
                <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
                <span className="min-w-0">{section.label}</span>
                <Text as="span" variant="caption" tone="muted">
                  {section.items.length}
                  <span className="sr-only"> {section.items.length === 1 ? 'item' : 'items'}</span>
                </Text>
              </button>
            </Text>
            <div id={bodyId} hidden={!open}>
              {open ? renderRows(section) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface ListRowsProps {
  readonly items: readonly Item[];
  readonly columns: readonly TableColumn<Item>[];
  readonly sort: TableSort | undefined;
  readonly onSortChange: (sort: TableSort) => void;
  readonly rowContextMenu?: (item: Item) => MenuEntry[];

  /** Which rows are selected and what a touch long-press on one does. */
  readonly rowSelection: RowSelection;

  /** The table's accessible name: the list's, or the section's heading when it is grouped. */
  readonly caption: string;

  /** Dragged widths, kept per device (column-widths.ts), and where a drag writes them. */
  readonly widths?: WidthControl | undefined;
}

interface RowSelection {
  readonly selected: (item: Item) => boolean;
  readonly longPress: ((item: Item) => boolean) | undefined;
  readonly drag: ((item: Item) => TableRowDrag) | undefined;
}

type RowGestures = ReturnType<typeof rowGestures>;

interface WidthControl {
  readonly columnWidths: Readonly<Record<string, number>>;
  readonly onColumnResize: (columnKey: string, width: number) => void;
  readonly onColumnWidthReset: (columnKey: string) => void;
}

/** Which row a list row's menu acts on, for the name a screen reader hears. */
function rowMenuLabel(item: Item): string {
  return `${item.title || 'Untitled'} actions`;
}

function ListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange, rowContextMenu, rowSelection, caption, widths } =
    props;
  if (items.length <= VIRTUALIZATION_THRESHOLD) {
    return (
      <Table<Item>
        caption={caption}
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        emptyMessage="Nothing in here yet."
        {...(sort === undefined ? {} : { sort })}
        {...(widths ?? {})}
        onSortChange={onSortChange}
        rowSelected={rowSelection.selected}
        {...(rowSelection.drag === undefined ? {} : { rowDrag: rowSelection.drag })}
        {...(rowSelection.longPress === undefined ? {} : { rowLongPress: rowSelection.longPress })}
        {...(rowContextMenu === undefined
          ? {}
          : { rowContextMenu, rowContextMenuLabel: rowMenuLabel })}
      />
    );
  }

  return <VirtualListRows {...props} />;
}

function VirtualListRows(props: ListRowsProps): ReactNode {
  const { items, columns, sort, onSortChange, rowContextMenu, rowSelection, caption } = props;
  const rootRef = useRef<HTMLTableElement>(null);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(() => items.map((item) => item.id), [items]);
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: ESTIMATED_ROW_HEIGHT,
  });
  const rows = windowed.indexes.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });

  return (
    <Table<Item>
      tableRef={rootRef}
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(item) => item.id}
      emptyMessage="Nothing in here yet."
      {...(sort === undefined ? {} : { sort })}
      onSortChange={onSortChange}
      rowSelected={rowSelection.selected}
      {...(rowSelection.drag === undefined ? {} : { rowDrag: rowSelection.drag })}
      {...(rowSelection.longPress === undefined ? {} : { rowLongPress: rowSelection.longPress })}
      {...(rowContextMenu === undefined
        ? {}
        : { rowContextMenu, rowContextMenuLabel: rowMenuLabel })}
      virtualization={{
        totalRows: items.length,
        rowIndexes: windowed.indexes,
        spacerHeights: virtualSpacers(windowed.offsets, windowed.indexes),
      }}
    />
  );
}

/**
 * What the list says when the filters have removed everything.
 *
 * Says how many are hidden, because "no items match" leaves open the possibility that the item was
 * empty all along, and the count is the proof that it was not.
 */
function hiddenByFilters(total: number): string {
  return total === 1
    ? 'The one item in here is hidden by the current filters.'
    : `All ${String(total)} items in here are hidden by the current filters.`;
}

/**
 * The columns, in order: the title first, then the properties.
 *
 * The title leads unconditionally and is the row header, because it is how a person names the row
 * and how a screen reader announces which row a cell belongs to. A view that lists its own columns
 * is choosing which *properties* to show and in what order - it is not choosing whether the row
 * says what it is - so a `title` entry in that list is dropped rather than rendered twice.
 *
 * A configured column whose property is not in the schema still gets a column, headed by its key.
 * The alternative is dropping it silently, which turns a renamed property into a column that
 * vanished for no stated reason; a column of blanks under an unfamiliar heading at least says
 * where to look.
 */
function buildColumns(
  view: View | null,
  schema: EffectiveSchema | null,
  gestures: (item: Item) => RowGestures,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
  refusals: CellRefusalStore,
): readonly TableColumn<Item>[] {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  return [
    {
      key: TITLE_COLUMN_KEY,
      header: 'Title',
      rowHeader: true,
      sortable: true,
      cell: (item) => (
        // Read-only, unlike every other column, and deliberately: renaming an item goes through the
        // tree rather than through a property write, and the row header has to stay the row's
        // primary affordance - a text box here would put an edit where a person expects a link.
        //
        // A button in the cell rather than a click handler on the row: a clickable <tr> cannot be
        // reached by a keyboard and announces nothing to a screen reader, so the affordance goes
        // on the one thing in the row that already names the destination.
        <button
          type="button"
          {...gestures(item)}
          className={cn(
            'cursor-default text-left hover:text-accent-text pointer-coarse:min-h-(--control-lg)',
            focusRing,
          )}
        >
          {item.title.length > 0 ? item.title : 'Untitled'}
        </button>
      ),
    },
    ...keys.map((key): TableColumn<Item> => {
      const definition = definitions.get(key);

      return {
        key,
        header: definition?.label ?? key,
        sortable: true,
        cell: (item) => renderProperty(item, key, definition, write, refusals),

        // Numbers read right-aligned so their digits line up; everything else keeps the table's
        // own default rather than restating it.
        ...(definition?.type === 'number' ? { align: 'end' as const } : {}),
      };
    }),
  ];
}

/**
 * One property cell: a control where this build knows the property type, and the stored value where
 * it does not.
 *
 * The unknown case reads rather than edits, and it renders as bare text rather than through the
 * read-only floor `PropertyInput` falls back to. That floor explains itself in a sentence, and a
 * sentence inside a table cell becomes part of the cell's accessible name - so the cell holding
 * "four of five" would announce a paragraph about property types instead of the value.
 *
 * A column the schema does not describe at all has no type to dispatch on and no label to name a
 * control with, so it reads too.
 */
function renderProperty(
  item: Item,
  key: string,
  definition: PropertyDefinition | undefined,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
  refusals: CellRefusalStore,
): ReactNode {
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return readPropertyText(item, key);
  }

  return (
    <ListCell
      item={item}
      property={definition}
      onWrite={(value) => write(item.id, key, value)}
      refusal={refusals.read(item.id, key)}
      onRefusalChange={(refusal) => {
        refusals.write(item.id, key, refusal);
      }}
    />
  );
}

interface CellRefusalStore {
  readonly read: (itemId: string, key: string) => string | null;
  readonly write: (itemId: string, key: string, refusal: string | null) => void;
}

function cellRefusalKey(itemId: string, key: string): string {
  return `${itemId}\u0000${key}`;
}

function MobileListRows({
  items,
  columns: allColumns,
  sort,
  onSortChange,
  rowContextMenu,
  rowSelection,
  caption,
  showSort,
}: ListRowsProps & { readonly showSort: boolean }): ReactNode {
  const [limit, setLimit] = useState(40);
  // The selection gutter is not a field: it is drawn beside the row, and only while selecting.
  const columns = allColumns.filter((column) => column.key !== SELECT_COLUMN_KEY);
  const selectColumn = allColumns.find((column) => column.key === SELECT_COLUMN_KEY);
  const selecting = items.some(rowSelection.selected);
  return (
    <section aria-label={caption} className="flex min-w-0 flex-col gap-3">
      {showSort ? (
        <MobileSortBar columns={columns} sort={sort} onSortChange={onSortChange} />
      ) : null}
      <ul className="divide-y divide-divider">
        {items.slice(0, limit).map((item) =>
          // A long press is the phone's right-click: the same actions the desktop rows offer, so a
          // row on a phone is not the one place an item cannot be moved, pinned or deleted from.
          rowContextMenu === undefined ? (
            <MobileRow
              key={item.id}
              item={item}
              columns={columns}
              selectColumn={selecting ? selectColumn : undefined}
              selected={rowSelection.selected(item)}
            />
          ) : (
            <ContextMenu
              key={item.id}
              label={`${item.title || 'Untitled'} actions`}
              items={() => rowContextMenu(item)}
              {...(rowSelection.longPress === undefined
                ? {}
                : { onLongPress: () => rowSelection.longPress?.(item) === true })}
            >
              {(contextTarget) => (
                <MobileRow
                  item={item}
                  columns={columns}
                  target={contextTarget}
                  selectColumn={selecting ? selectColumn : undefined}
                  selected={rowSelection.selected(item)}
                />
              )}
            </ContextMenu>
          ),
        )}
      </ul>
      {items.length > limit ? (
        <Button
          variant="secondary"
          onClick={() => {
            setLimit((current) => current + 40);
          }}
        >
          Show more items
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The phone's sort control: a select for the key and a button for the direction, because a phone
 * has no column headers to click. Drawn once above a grouped list rather than once per section -
 * the sort applies inside every section alike, and five copies of one control would be four
 * controls too many.
 */
function MobileSortBar({
  columns,
  sort,
  onSortChange,
}: Pick<ListRowsProps, 'columns' | 'sort' | 'onSortChange'>): ReactNode {
  return (
    <div role="group" aria-label="List sort" className="flex flex-wrap items-center gap-2">
      <Text as="span" variant="caption">
        Sort by
      </Text>
      <Select
        aria-label="Sort by"
        value={sort?.columnKey ?? ''}
        className="w-auto min-w-0 flex-1"
        onChange={(event) => {
          onSortChange({
            columnKey: event.target.value,
            direction: sort?.direction ?? 'ascending',
          });
        }}
      >
        <option value="" disabled>
          Item order
        </option>
        {columns.map((column) => (
          <option key={column.key} value={column.key}>
            {column.header}
          </option>
        ))}
      </Select>
      <Button
        variant="ghost"
        disabled={!sort}
        onClick={() => {
          if (sort)
            onSortChange({
              ...sort,
              direction: sort.direction === 'ascending' ? 'descending' : 'ascending',
            });
        }}
      >
        {sort?.direction === 'descending' ? 'Descending' : 'Ascending'}
      </Button>
    </div>
  );
}

/** One phone row: the first column's cell, and the rest folded under "Fields". */
function MobileRow(props: {
  readonly item: Item;
  readonly columns: ListRowsProps['columns'];
  readonly target?: ContextMenuTargetProps;
  readonly selectColumn?: TableColumn<Item> | undefined;
  readonly selected: boolean;
}): ReactNode {
  const { item, columns, target, selectColumn, selected } = props;

  return (
    <li {...target} className={cn('min-w-0 py-3', selected && 'bg-accent/10')}>
      <div className="flex items-center gap-2 py-2">
        {selectColumn?.cell(item)}
        {columns[0]?.cell(item)}
      </div>
      {columns.length > 1 ? (
        <details>
          <summary className="cursor-default py-2">Fields</summary>
          <dl className="flex flex-col gap-3">
            {columns.slice(1).map((column) => (
              <div key={column.key} className="min-w-0">
                <dt>
                  <Text as="span" variant="caption" tone="muted">
                    {column.header}
                  </Text>
                </dt>
                <dd className="min-w-0 py-1">{column.cell(item)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}
