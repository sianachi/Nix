import { type CellRef, cellKey, parseCellKey, rangeContains } from '@nix/sheet';
import {
  Button,
  ContextMenu,
  Icon,
  Popover,
  Text,
  cn,
  focusRing,
  focusRingInset,
  gridRangeCell,
} from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Square,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { type Item, type PropertyDefinition, type View } from '../core/container-model';
import { PropertyInput, isKnownPropertyType } from '../../properties/property-input';
import { isComputedType } from '../core/property-types';
import { CreateItemControl } from '../core/create-item-control';
import { FILL_SERIES_SHORTCUT } from '../../keyboard/shortcut-registry';
import { formatShortcut } from '../../lib/shortcuts';
import { useViewSuggestionPreference } from '../../settings/editor/suggestion-preferences';
import { FillSeriesOffer } from './fill-series-offer';
import { suggestSourceOf } from '../suggest/suggest-source';
import type { ContainerData, PlanOutcome, PlanWrite } from '../core/use-container';
import { drawable, useViewChrome } from '../core/view-chrome';
import {
  COLUMN_WIDTH,
  clampWidth,
  resetColumnWidth,
  setColumnWidth,
  useColumnWidths,
} from '../core/column-widths';
import { useViewState, type SortDirection } from '../core/view-state';
import { CellEditor } from '../sheet/cell-editor';
import { parseTsv, rangeToTsv } from '../sheet/clipboard';
import { gridKeyAction } from '../sheet/grid-keys';
import {
  INITIAL_SELECTION,
  clamp,
  selectedRange,
  selectionReducer,
  type GridBounds,
} from '../sheet/selection';
import { columnOffsets, columnWindow, rowWindow } from '../sheet/windowing';
import {
  TITLE_COLUMN_KEY,
  cellDisplay,
  cellText,
  clearPlan,
  columnWidth,
  coerceCellText,
  fillPlan,
  pastePlan,
  rangeTextMap,
  resolveColumns,
  seriesFillOffer,
  seriesFillPlan,
  type SpreadsheetColumn,
  type WritePlan,
} from './grid-model';

/**
 * The spreadsheet view: a container's children as a windowed, range-selectable grid.
 *
 * The *view* axis of the two-axis rule: rows are children, cells are property values, and every
 * edit is a property write on an item - visible in every other view, and to everybody else. The
 * spreadsheet *body* is the other axis (free cells, formulas, a shared document); the two share
 * the windowing arithmetic, the selection reducer, the keyboard ladder (`grid-keys.ts`) and the
 * clipboard format, and nothing else.
 *
 * **The keyboard model is the body's, kept identical through the shared ladder** (goal 3.8 names
 * it as the reference): focus stays on the scroller with `aria-activedescendant` naming the active
 * cell - a roving tabindex breaks the moment windowing unmounts the focused cell - arrows move,
 * Shift extends, typing replaces, Enter edits (or opens, on a title), Tab moves with Escape
 * releasing it.
 *
 * Cells stay windowed; only the active cell mounts an editor. Text typing uses the same coercion
 * as paste and fill, while property choices use the shared picker rather than free-form text.
 */

/** Cell geometry is a fixed 32px of runtime arithmetic, shared by rows, header and overlay. */
const ROW_HEIGHT = 32;

/**
 * The scroller's own viewport. The pane scrolls vertically, so the grid needs a bounded height for
 * windowing to have something to window against; the `min()` keeps it inside a short window or a
 * high zoom rather than overflowing it (the calendar's `min-h-[520px]` frame is the size's
 * precedent, the direction here is inverted on purpose - a maximum, shrinking with the viewport).
 */
const SCROLLER_HEIGHT_CLASS = 'h-[min(520px,60dvh)]';

/** What one bulk gesture is called in the notice about it. */
type PlanVerb = 'taken' | 'filled' | 'cleared';

export interface SpreadsheetViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export function SpreadsheetView(props: SpreadsheetViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  // The URL wins, the stored view is the starting point - the list's rule, verbatim.
  const sortBy = viewState.sortBy ?? view.sortBy ?? null;
  const direction: SortDirection =
    viewState.sortBy !== null
      ? viewState.direction
      : view.sortDescending
        ? 'descending'
        : 'ascending';

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this spreadsheet',
    // Like the list: nothing configured is still drawable, because the schema is the fallback and
    // titles exist with no schema at all.
    drawable: drawable(null),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as rows.',
    emptyAction: <CreateItemControl label="Add an item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail:
        total === 1
          ? 'The one item in here is hidden by the current filters.'
          : `All ${String(total)} items in here are hidden by the current filters.`,
    }),
    savedRules: view.filters,
    view,
    sortBy,
    descending: direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  return (
    <div className="min-w-0 max-w-full">
      {chrome.notice}

      <SpreadsheetGrid
        items={chrome.items}
        columns={resolveColumns(view, container.schema)}
        properties={container.schema?.properties ?? []}
        sortBy={sortBy}
        direction={direction}
        onSort={(key, next) => {
          viewState.setSort(key, next);
        }}
        onWrite={(itemId, bag) => container.setProperties(itemId, bag)}
        onWriteMany={(writes) => container.setPropertiesMany(writes)}
        onOpen={onOpen}
        viewId={view.id}
      />

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        suggest={suggestSourceOf(container, onOpen)}
        className="mt-2"
      />
    </div>
  );
}

interface SpreadsheetGridProps {
  readonly items: readonly Item[];
  readonly columns: readonly SpreadsheetColumn[];
  readonly properties: readonly PropertyDefinition[];
  readonly sortBy: string | null;
  readonly direction: SortDirection;
  readonly onSort: (key: string, direction: SortDirection) => void;

  /** Writes one cell's edit and answers with the refusal, or null when stored. */
  readonly onWrite: (itemId: string, bag: Record<string, unknown>) => Promise<string | null>;

  /** Writes one gesture's worth of rows - paste, fill, clear - and answers for all of them. */
  readonly onWriteMany: (writes: readonly PlanWrite[]) => Promise<PlanOutcome>;

  readonly onOpen: (itemId: string) => void;

  /** The view whose dragged column widths are kept per device (column-widths.ts). */
  readonly viewId: string;
}

function SpreadsheetGrid(props: SpreadsheetGridProps): ReactNode {
  const {
    items,
    columns,
    properties,
    sortBy,
    direction,
    onSort,
    onWrite,
    onWriteMany,
    onOpen,
    viewId,
  } = props;
  const storedWidths = useColumnWidths(viewId);
  const resizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const [selection, dispatch] = useReducer(selectionReducer, INITIAL_SELECTION);

  // Scroll and viewport state live HERE, in the grid, not in SpreadsheetView above. This is
  // load-bearing: scrolling must not re-run useViewChrome's filter and sort over all children.
  // Lifting either of these up would put a full-container sort on every scroll event.
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  /**
   * What the grid last had to say: a refusal, a bulk gesture's outcome, or why a keystroke did
   * nothing. One region rather than per-cell state, because the cells concerned may already be
   * scrolled out of the DOM - the sentence carries the row and column names instead of pointing
   * at a place that may not be mounted. Cleared when the active cell moves, so a stale sentence
   * does not sit under the grid describing an edit from minutes ago.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [propertyEdit, setPropertyEdit] = useState<{
    itemId: string;
    propertyKey: string;
  } | null>(null);
  const [propertyRefusal, setPropertyRefusal] = useState<string | null>(null);
  const propertyEditRef = useRef(propertyEdit);
  const propertyWriteRef = useRef(0);
  const propertyPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    propertyEditRef.current = propertyEdit;
  }, [propertyEdit]);

  // Whether Tab is a cell movement or an exit. Escape releases the trap and any grid keystroke
  // restores it - blurring on Escape, which this replaced, sent focus to <body>, so the promised
  // "Escape, then Tab" resumed from the top of the document instead of from after the grid.
  const [trapsTab, setTrapsTab] = useState(true);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const menuCellRef = useRef<CellRef | null>(null);

  /**
   * Whether the open edit has already been answered - committed or cancelled. A ref rather than
   * state because the editor's blur fires synchronously inside `scrollerRef.current?.focus()`,
   * before React has re-rendered: the blur handler's closure still says the edit is open, and
   * without this flag the blur would commit the same draft a second time (or commit a draft that
   * Escape had just abandoned). On a click-away it is the blur, fired by the cell handler's
   * `focus()`, that commits first; the cell handler's own `commitDraft` is the call this flag
   * then neutralises.
   */
  const editSettledRef = useRef(false);

  /**
   * Which cell the open edit belongs to, by identity rather than by index. The rows reorder under
   * the grid - an optimistic write in the sorted column moves its own row - and an edit committed
   * against `items[active.row]` after a reorder would write to whichever item slid into that
   * index.
   */
  const editingRef = useRef<{ itemId: string; columnKey: string } | null>(null);

  const bounds: GridBounds = { rows: items.length, cols: columns.length };
  const active = clamp(selection.active, bounds);
  const activeColumn = columns[active.col];
  const activeItem = items[active.row];
  const activeProperty = properties.find((property) => property.key === activeColumn?.key);
  const editedItem =
    propertyEdit === null ? undefined : items.find((item) => item.id === propertyEdit.itemId);
  const editedProperty = properties.find((property) => property.key === propertyEdit?.propertyKey);
  if (propertyEdit !== null && (editedItem === undefined || editedProperty === undefined)) {
    setPropertyEdit(null);
    setPropertyRefusal(null);
  }

  function canEditProperty(property: PropertyDefinition | undefined): boolean {
    return (
      property !== undefined && isKnownPropertyType(property.type) && !isComputedType(property.type)
    );
  }

  function closePropertyEdit(commit = true): void {
    if (
      commit &&
      document.activeElement instanceof HTMLElement &&
      propertyPanelRef.current?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    propertyEditRef.current = null;
    setPropertyEdit(null);
  }

  function usesPicker(property: PropertyDefinition | undefined): boolean {
    return property !== undefined && !['text', 'long_text', 'url'].includes(property.type);
  }

  /**
   * The selection follows the item, not the index. Recorded and reconciled during render (the
   * `useDraft` pattern): when `items` reorders under the grid, the active cell is moved to where
   * its item went, so the next Delete or fill acts on the row somebody selected rather than on
   * whichever row slid into its place. The anchor is deliberately dropped - a range of indexes
   * over a reordered list no longer means anything.
   */
  const [tracked, setTracked] = useState<{
    items: readonly Item[];
    activeId: string | null;
  }>({ items, activeId: activeItem?.id ?? null });

  if (items !== tracked.items) {
    const followedIndex =
      tracked.activeId === null ? -1 : items.findIndex((item) => item.id === tracked.activeId);
    setTracked({ items, activeId: tracked.activeId });

    if (followedIndex !== -1 && followedIndex !== active.row && selection.mode === 'nav') {
      dispatch({
        type: 'moveTo',
        ref: clamp({ row: followedIndex, col: active.col }, bounds),
        extend: false,
      });
    }
  } else if ((activeItem?.id ?? null) !== tracked.activeId) {
    // The person moved the selection: record where it is, and retire whatever sentence the last
    // cell earned - a stale notice under the grid describes an edit that is no longer where they
    // are. Render-time adjustment, the same pattern as the block above.
    setTracked({ items, activeId: activeItem?.id ?? null });
    setNotice(null);
  }

  // Derived per render, deliberately unmemoized - the body grid's argument holds here too:
  // nothing depends on these arrays' identity, the reveal effect keys on scalars, and the work is
  // O(columns), noise beside the cell window it feeds.
  // A dragged width wins over the type's default; nothing stored draws the defaults.
  const widths = columns.map((column) => storedWidths[column.key] ?? columnWidth(column));
  const offsets = columnOffsets(widths);
  const totalWidth = offsets[columns.length] ?? 0;
  const totalHeight = items.length * ROW_HEIGHT;

  const rows = rowWindow({
    scrollTop: scroll.top,
    viewportHeight: viewport.height,
    rowHeight: ROW_HEIGHT,
    totalRows: bounds.rows,
  });
  const cols = columnWindow({
    scrollLeft: scroll.left,
    viewportWidth: viewport.width,
    offsets,
  });

  const range = selectedRange(selection);
  const rangeIsCell = range.startRow === range.endRow && range.startCol === range.endCol;

  /**
   * The unprompted offer to continue a pattern: detection only - the seed, its step and a short
   * preview - and only when every target cell is empty, so the button can never overwrite. Cheap
   * enough to derive on each render (a walk down the selected columns that stops at the first
   * filled target), so it carries no memo and no dependency on the item list's identity; the plan
   * itself is built only when somebody asks for it, in `fillSeries`.
   */
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);
  const rangeKey = `${String(range.startRow)}:${String(range.startCol)}:${String(range.endRow)}:${String(range.endCol)}`;

  // Which selection's offer was dismissed. Keyed by the range so selecting somewhere else offers
  // again; a dismissal is about this guess, not about the feature.
  const [dismissedFill, setDismissedFill] = useState<string | null>(null);
  const fillOffer =
    viewSuggestions === 'on' &&
    selection.mode === 'nav' &&
    range.endRow > range.startRow &&
    dismissedFill !== rangeKey
      ? seriesFillOffer(range, items, columns)
      : null;
  const patternedColumn =
    fillOffer?.patterned === true
      ? (fillOffer.columns.find((fill) => fill.kind !== 'repeat') ?? null)
      : null;

  /**
   * Builds and applies the series fill for the current selection: the full plan, every value
   * coerced, computed here rather than on render because only the click and the shortcut need it.
   */
  function fillSeries(): boolean {
    const fill = range.endRow > range.startRow ? seriesFillPlan(range, items, columns) : null;
    if (fill === null || fill.rows === 0) {
      return false;
    }
    applyPlan(fill.plan, 'filled');
    return true;
  }

  const gridId = useId();
  const hintId = `${gridId}-hint`;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      // Identity-guarded: a resize callback that reports the same box must not re-render a few
      // hundred cells to change nothing.
      setViewport((current) => {
        const next = { width: scroller.clientWidth, height: scroller.clientHeight };
        return next.width === current.width && next.height === current.height ? current : next;
      });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, []);

  // The active cell is kept on screen the way a caret is, keyed on its own geometry as scalars.
  const activeTop = active.row * ROW_HEIGHT;
  const activeLeft = offsets[active.col] ?? 0;
  const activeWidth = widths[active.col] ?? 0;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    if (activeTop < scroller.scrollTop) {
      scroller.scrollTop = activeTop;
    } else if (activeTop + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = activeTop + ROW_HEIGHT - scroller.clientHeight;
    }
    if (activeLeft < scroller.scrollLeft) {
      scroller.scrollLeft = activeLeft;
    } else if (activeLeft + activeWidth > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = activeLeft + activeWidth - scroller.clientWidth;
    }
  }, [activeTop, activeLeft, activeWidth]);

  // The editor overlay takes focus when an edit begins; focus returns to the scroller on commit.
  useEffect(() => {
    if (selection.mode === 'edit') {
      editorRef.current?.focus();
      editorRef.current?.select();
    }
  }, [selection.mode]);

  function say(rowLabel: string, columnLabel: string, sentence: string): void {
    setNotice(`${columnLabel} for ${rowLabel}: ${sentence}`);
  }

  /** The one sentence a bulk gesture gets, whatever mixture of outcomes it had. */
  function applyPlan(plan: WritePlan, verb: PlanVerb): void {
    setNotice(null);

    const writes: PlanWrite[] = plan.writes.map((write) => ({
      itemId: write.item.id,
      label: write.item.title || 'Untitled',
      properties: write.bag,
    }));

    void onWriteMany(writes)
      .then((outcome) => {
        const parts: string[] = [];

        if (outcome.refused.length > 0) {
          const first = outcome.refused[0];
          parts.push(
            `${String(outcome.refused.length)} of ${String(writes.length)} rows were refused` +
              (first === undefined ? '.' : ` - ${first.label}: ${first.reason}`),
          );
        }

        if (plan.unusable > 0) {
          parts.push(
            plan.unusable === 1
              ? `One value could not be ${verb} and was left as it was.`
              : `${String(plan.unusable)} values could not be ${verb} and were left as they were.`,
          );
        }

        setNotice(parts.length === 0 ? null : parts.join(' '));
      })
      .catch(() => {
        setNotice('Those changes could not be sent. Check the connection and try again.');
      });
  }

  function commitDraft(then: 'down' | 'right' | 'stay'): boolean {
    if (selection.mode !== 'edit' || editSettledRef.current) {
      return true;
    }

    const editing = editingRef.current;
    const item = items.find((entry) => entry.id === editing?.itemId);
    const column = columns.find((entry) => entry.key === editing?.columnKey);

    if (item === undefined || !column?.editable) {
      editSettledRef.current = true;
      dispatch({ type: 'commit', then, bounds });
      scrollerRef.current?.focus({ preventScroll: true });
      return true;
    }

    if (selection.draft === cellText(item, column)) {
      editSettledRef.current = true;
      dispatch({ type: 'commit', then, bounds });
      scrollerRef.current?.focus({ preventScroll: true });
      return true;
    }

    const coerced = coerceCellText(selection.draft, column.type);

    // Nothing storable: said out loud, and the edit stays open to be corrected rather than being
    // silently dropped - the caller keeps its gesture from closing the editor (see onMouseDown).
    if (!coerced.ok) {
      say(item.title || 'Untitled', column.label, coerced.reason);
      return false;
    }

    setNotice(null);
    editSettledRef.current = true;

    void onWrite(item.id, { [column.key]: coerced.value })
      .then((refusal) => {
        if (refusal !== null) {
          say(item.title || 'Untitled', column.label, refusal);
        }
      })
      .catch(() => {
        say(
          item.title || 'Untitled',
          column.label,
          'that change could not be sent. Check the connection and try again.',
        );
      });

    dispatch({ type: 'commit', then, bounds });
    scrollerRef.current?.focus({ preventScroll: true });
    return true;
  }

  function cancelEdit(): void {
    editSettledRef.current = true;
    dispatch({ type: 'cancel' });
    scrollerRef.current?.focus({ preventScroll: true });
  }

  function beginEdit(source: 'typing' | 'open', draft: string, ref: CellRef = active): void {
    const column = columns[ref.col];
    const item = items[ref.row];
    if (column === undefined || item === undefined) {
      return;
    }

    // The title opens rather than edits: renaming goes through the tree, not a property write,
    // and Enter on a row's name is the grid's way of following it. A keystroke that would have
    // typed over it is answered rather than swallowed - a refusal has to be distinguishable from
    // a no-op.
    if (column.key === TITLE_COLUMN_KEY) {
      if (source === 'open') {
        onOpen(item.id);
      } else {
        setNotice('A row’s name is changed in the item itself - press Enter to open it.');
      }
      return;
    }

    const property = properties.find((entry) => entry.key === column.key);
    if (
      canEditProperty(property) &&
      property !== undefined &&
      usesPicker(property) &&
      (source === 'open' ||
        !['text', 'long_text', 'url', 'number', 'estimate'].includes(property.type))
    ) {
      if (!commitDraft('stay')) return;
      setPropertyRefusal(null);
      const edit = { itemId: item.id, propertyKey: property.key };
      propertyEditRef.current = edit;
      setPropertyEdit(edit);
      return;
    }

    if (!column.editable) {
      say(
        item.title || 'Untitled',
        column.label,
        'this property type cannot be edited here, so the value is shown as stored.',
      );
      return;
    }

    editSettledRef.current = false;
    editingRef.current = { itemId: item.id, columnKey: column.key };
    dispatch({ type: 'startEdit', draft, source });
  }

  function captureMenuCell(target: EventTarget | null): void {
    menuCellRef.current =
      target instanceof Element
        ? parseCellKey(target.closest('[data-sheet-cell]')?.getAttribute('data-sheet-cell') ?? '')
        : null;
  }

  function isOccupied(ref: CellRef): boolean {
    const item = items[ref.row];
    const column = columns[ref.col];
    return item !== undefined && column !== undefined && cellText(item, column).length > 0;
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (selection.mode === 'edit') {
      return;
    }
    if (event.key === 'Escape') {
      // Escape releases the Tab trap; the next Tab then leaves the grid in document order, which
      // is what the hint promises.
      event.preventDefault();
      setTrapsTab(false);
      return;
    }
    if (event.key === 'Tab' && !trapsTab) {
      return;
    }
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.shiftKey && (event.key === 'd' || event.key === 'D')) {
      // Fill by pattern: each selected column continued from the filled cells at its top - the
      // series `seriesFillPlan` finds, or the last value repeated when there is none. Shift is the
      // only difference from the plain fill below, which copies the first row verbatim.
      event.preventDefault();
      setTrapsTab(true);
      if (!fillSeries()) {
        setNotice(
          'Select a column with filled cells at the top and rows below them to continue a series.',
        );
      }
      return;
    }

    if (meta && (event.key === 'd' || event.key === 'D')) {
      // Fill down: the range's first row repeated over the rows below it - the fill the goal
      // names, on the incumbents' own key. On a single cell there is nothing below the pattern,
      // and silence would be indistinguishable from breakage.
      event.preventDefault();
      setTrapsTab(true);
      if (range.endRow === range.startRow) {
        setNotice('Select rows to fill down: the first row of the selection is the pattern.');
      } else {
        applyPlan(fillPlan(range, items, columns), 'filled');
      }
      return;
    }

    // Everything else is the ladder both grids share; only what the result means - what a clear
    // clears, what text an opened edit starts from - is this grid's own.
    const result = gridKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        meta,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        active,
        bounds,
        pageRows: Math.max(1, Math.floor(viewport.height / ROW_HEIGHT) - 1),
        isOccupied,
      },
    );
    if (result === null) {
      return;
    }

    event.preventDefault();
    setTrapsTab(true);
    switch (result.kind) {
      case 'action':
        dispatch(result.action);
        return;
      case 'edit':
        beginEdit(
          result.source,
          result.source === 'typing'
            ? result.draft
            : activeItem !== undefined && activeColumn !== undefined
              ? cellText(activeItem, activeColumn)
              : '',
        );
        return;
      case 'clear':
        applyPlan(clearPlan(range, items, columns), 'cleared');
    }
  }

  const visibleRows: number[] = [];
  for (let row = rows.first; row <= rows.last; row += 1) {
    visibleRows.push(row);
  }
  const visibleCols: number[] = [];
  for (let col = cols.first; col <= cols.last; col += 1) {
    visibleCols.push(col);
  }

  // design-token-exempt: the editor overlay, header strip and scrollable canvas sit at grid
  // geometry computed at runtime.
  const editorStyle = {
    top: `${String(activeTop)}px`,
    left: `${String(activeLeft)}px`,
    width: `${String(activeWidth)}px`,
    height: `${String(ROW_HEIGHT)}px`,
  };
  const headerStripStyle = {
    width: `${String(totalWidth)}px`,
    height: `${String(ROW_HEIGHT)}px`,
    transform: `translateX(-${String(scroll.left)}px)`,
  };
  const canvasStyle = { width: `${String(totalWidth)}px`, height: `${String(totalHeight)}px` };

  return (
    <div className="min-w-0 max-w-full">
      <p id={hintId} className="sr-only">
        Arrow keys move the active cell, and Shift extends the selection. Typing replaces text and
        number cells; Enter opens the property's editor, or opens the item on a title. Clicking a
        choice, checkbox, date or number cell opens its typed control. Control or Command with C
        copies and V pastes the selection as tab-separated text, D fills down from the selection’s
        first row, and Shift with D continues a series such as Week 1, Week 2 down the selection.
        Delete clears the selection. Tab and Shift+Tab move between cells rather than leaving the
        grid; press Escape, then Tab, to move focus out of it.
      </p>

      {/* The same model, findable by sight: a tap or a click alone reaches selection, editing
          and opening - a second tap on the already-active cell edits it, and this button opens
          it - so the keyboard ladder below is a shortcut, not the only door. */}
      <div className="mb-1 flex min-w-0 flex-wrap items-start justify-between gap-2">
        <details className="min-w-0 flex-1">
          <summary
            className={cn(
              'inline-flex min-h-(--control-md) cursor-default items-center any-pointer-coarse:min-h-(--control-lg)',
              focusRing,
            )}
          >
            <Text as="span" variant="note" tone="muted">
              Keyboard
            </Text>
          </summary>
          <Text as="p" variant="note" tone="muted">
            Arrows move, Shift extends. Type to replace text and numbers. Enter edits a property or
            opens the item on a title. Click a choice, checkbox, date or number cell to use its
            typed control. Ctrl/Cmd+C copies and Ctrl/Cmd+V pastes tab-separated text, Ctrl/Cmd+D
            fills down, Ctrl/Cmd+Shift+D continues a series, Delete clears. Escape, then Tab, leaves
            the grid.
          </Text>
        </details>

        {selection.mode === 'edit' ? (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="icon"
              aria-label="Apply property edit"
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                commitDraft('stay');
              }}
            >
              <Icon icon={Check} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label="Cancel property edit"
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={cancelEdit}
            >
              <Icon icon={X} size="sm" />
            </Button>
          </div>
        ) : null}

        {usesPicker(activeProperty) || propertyEdit !== null ? (
          <Popover
            label={`Edit ${editedProperty?.label ?? activeColumn?.label ?? 'property'} for ${(editedItem?.title ?? activeItem?.title ?? '') || 'Untitled'}`}
            open={propertyEdit !== null && editedItem !== undefined && editedProperty !== undefined}
            onOpenChange={(open) => {
              if (!open) closePropertyEdit();
              else if (activeColumn !== undefined && activeItem !== undefined) {
                beginEdit('open', cellText(activeItem, activeColumn));
              }
            }}
            trigger={(trigger) => (
              <Button
                {...trigger}
                variant="secondary"
                className="min-w-0 max-w-full"
                disabled={!canEditProperty(activeProperty)}
                aria-label={`Edit ${activeColumn?.label ?? 'property'} for ${(activeItem?.title ?? '') || 'Untitled'}`}
              >
                <span className="truncate">Edit {activeColumn?.label ?? 'property'}</span>
              </Button>
            )}
          >
            {({ close }) => (
              // Escape cancels the unsent draft before closing can blur its control.
              // eslint-disable-next-line jsx-a11y/no-static-element-interactions
              <div
                ref={propertyPanelRef}
                className="flex flex-col gap-3"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || event.defaultPrevented) return;
                  event.preventDefault();
                  event.stopPropagation();
                  closePropertyEdit(false);
                  requestAnimationFrame(() => scrollerRef.current?.focus({ preventScroll: true }));
                }}
              >
                {editedItem !== undefined && editedProperty !== undefined ? (
                  <PropertyInput
                    key={`${editedItem.id}:${editedProperty.key}`}
                    item={editedItem}
                    property={editedProperty}
                    error={propertyRefusal}
                    onCommit={(value) => {
                      const write = ++propertyWriteRef.current;
                      setPropertyRefusal(null);
                      setNotice(null);
                      void onWrite(editedItem.id, { [editedProperty.key]: value })
                        .then((refusal) => {
                          if (
                            propertyWriteRef.current === write &&
                            propertyEditRef.current?.itemId === editedItem.id &&
                            propertyEditRef.current.propertyKey === editedProperty.key
                          )
                            setPropertyRefusal(refusal);
                          if (refusal !== null)
                            say(editedItem.title || 'Untitled', editedProperty.label, refusal);
                        })
                        .catch(() => {
                          const refusal =
                            'That change could not be sent. Check the connection and try again.';
                          if (
                            propertyWriteRef.current === write &&
                            propertyEditRef.current?.itemId === editedItem.id &&
                            propertyEditRef.current.propertyKey === editedProperty.key
                          )
                            setPropertyRefusal(refusal);
                          say(editedItem.title || 'Untitled', editedProperty.label, refusal);
                        });
                    }}
                  />
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    close();
                    requestAnimationFrame(() =>
                      scrollerRef.current?.focus({ preventScroll: true }),
                    );
                  }}
                >
                  Done
                </Button>
              </div>
            )}
          </Popover>
        ) : (
          <Button
            variant="secondary"
            className="min-w-0 max-w-full"
            disabled={!canEditProperty(activeProperty)}
            aria-label={`Edit ${activeColumn?.label ?? 'property'} for ${(activeItem?.title ?? '') || 'Untitled'}`}
            onClick={() => {
              if (activeColumn !== undefined && activeItem !== undefined)
                beginEdit('open', cellText(activeItem, activeColumn));
            }}
          >
            <span className="truncate">Edit {activeColumn?.label ?? 'property'}</span>
          </Button>
        )}

        {/* The pointer-only way to open a row: tapping the title twice already does it, but a
            visible control means opening never depends on a double-click or a keyboard. */}
        <Button
          variant="secondary"
          className="min-w-0 max-w-full"
          aria-label={
            activeItem === undefined ? 'Open item' : `Open ${activeItem.title || 'Untitled'}`
          }
          disabled={activeItem === undefined}
          onClick={() => {
            if (activeItem !== undefined) {
              onOpen(activeItem.id);
            }
          }}
        >
          <Icon icon={SquareArrowOutUpRight} size="sm" />
          <span className="truncate">
            {activeItem === undefined ? 'Open' : `Open ${activeItem.title || 'Untitled'}`}
          </span>
        </Button>
      </div>

      {/* The header: sort controls, pinned above the scroller and following its horizontal
          scroll. Outside the grid role on purpose - the body grid's own precedent - so each
          header is an ordinary focusable button rather than a cell the activedescendant pattern
          cannot reach. That placement is also why the sorted state is named in the label rather
          than as aria-sort: there is no columnheader role here for aria-sort to sit on. */}
      <div className="overflow-hidden border-b border-divider bg-surface">
        <div className="relative" style={headerStripStyle}>
          {visibleCols.map((col) => {
            const column = columns[col];
            if (column === undefined) {
              return null;
            }
            const sorted = sortBy === column.key;
            // design-token-exempt: a column's place and width are grid geometry computed at runtime
            const style = {
              left: `${String(offsets[col] ?? 0)}px`,
              width: `${String(widths[col] ?? 0)}px`,
              height: `${String(ROW_HEIGHT)}px`,
            };
            const width = widths[col] ?? 0;
            // design-token-exempt: the handle sits on the column's right edge, grid geometry
            const handleStyle = { left: `${String((offsets[col] ?? 0) + width)}px` };
            return (
              <Fragment key={column.key}>
                <button
                  type="button"
                  aria-label={`Sort by ${column.label}${sorted ? `, currently ${direction}` : ''}`}
                  onClick={() => {
                    onSort(
                      column.key,
                      sorted && direction === 'ascending' ? 'descending' : 'ascending',
                    );
                  }}
                  className={cn(
                    'absolute top-0 flex cursor-default items-center gap-1 truncate border-r border-divider px-2 text-left text-sm font-semibold',
                    sorted ? 'text-accent-text' : 'text-foreground',
                    focusRing,
                  )}
                  style={style}
                >
                  {column.label}
                  {/* The neutral glyph on unsorted columns is what says "this sorts" to a sighted
                    visitor - Table.tsx's own convention, kept in step. */}
                  <span className={sorted ? '' : 'text-muted'}>
                    <Icon
                      icon={
                        sorted ? (direction === 'ascending' ? ArrowUp : ArrowDown) : ChevronsUpDown
                      }
                      size="sm"
                    />
                  </span>
                </button>
                {/* A focusable window-splitter on the column's edge (requirement 2): drag it, or
                  focus it and use the arrows; Home forgets the dragged width. The drag never
                  reaches the sort button behind it. */}
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ARIA's focusable separator with aria-valuenow is the window-splitter widget; jsx-a11y models separator only as a static divider. */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${column.label}`}
                  aria-valuenow={width}
                  aria-valuemin={COLUMN_WIDTH.min}
                  aria-valuemax={COLUMN_WIDTH.max}
                  aria-valuetext={`${String(width)} pixels`}
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a window-splitter separator is focusable by its ARIA definition
                  tabIndex={0}
                  className={cn(
                    'absolute top-0 z-10 h-8 w-3 -translate-x-1/2 cursor-col-resize touch-none',
                    focusRingInset,
                  )}
                  style={handleStyle}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resizeDrag.current = {
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      startWidth: width,
                    };
                  }}
                  onPointerMove={(event) => {
                    const drag = resizeDrag.current;
                    if (drag?.pointerId !== event.pointerId) return;
                    setColumnWidth(
                      viewId,
                      column.key,
                      clampWidth(drag.startWidth + event.clientX - drag.startX),
                    );
                  }}
                  onPointerUp={() => {
                    resizeDrag.current = null;
                  }}
                  onPointerCancel={() => {
                    resizeDrag.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      setColumnWidth(viewId, column.key, clampWidth(width - COLUMN_WIDTH.step));
                    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setColumnWidth(viewId, column.key, clampWidth(width + COLUMN_WIDTH.step));
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      resetColumnWidth(viewId, column.key);
                    } else if (event.key === 'Escape' && resizeDrag.current !== null) {
                      event.preventDefault();
                      setColumnWidth(viewId, column.key, resizeDrag.current.startWidth);
                      resizeDrag.current = null;
                    }
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-divider"
                  />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* The body: the one real scroller, and the keyboard's home. */}
      <ContextMenu
        label="Spreadsheet cell actions"
        items={() => {
          const ref = menuCellRef.current ?? active;
          const item = items[ref.row];
          const column = columns[ref.col];
          if (item === undefined || column === undefined) return [];
          return [
            {
              label: `Open ${item.title || 'Untitled'}`,
              onSelect: () => {
                onOpen(item.id);
              },
            },
            {
              label: `Edit ${column.label}`,
              disabled: !canEditProperty(
                properties.find((property) => property.key === column.key),
              ),
              onSelect: () => {
                if (!commitDraft('stay')) return;
                dispatch({ type: 'moveTo', ref, extend: false });
                beginEdit('open', cellText(item, column), ref);
              },
            },
            {
              label: `Clear ${column.label}`,
              disabled: !column.editable || cellText(item, column).length === 0,
              onSelect: () => {
                if (!commitDraft('stay')) return;
                dispatch({ type: 'moveTo', ref, extend: false });
                applyPlan(
                  clearPlan(
                    {
                      startRow: ref.row,
                      endRow: ref.row,
                      startCol: ref.col,
                      endCol: ref.col,
                    },
                    items,
                    columns,
                  ),
                  'cleared',
                );
              },
            },
          ];
        }}
      >
        {(target) => (
          <div
            {...target}
            ref={scrollerRef}
            role="grid"
            aria-label="Spreadsheet of items"
            aria-describedby={hintId}
            aria-rowcount={bounds.rows}
            aria-colcount={bounds.cols}
            aria-activedescendant={selection.mode === 'edit' ? undefined : cellId(gridId, active)}
            aria-multiselectable="true"
            tabIndex={0}
            onContextMenuCapture={(event) => {
              captureMenuCell(event.target);
            }}
            onPointerDownCapture={(event) => {
              captureMenuCell(event.target);
            }}
            onKeyDownCapture={() => {
              menuCellRef.current = null;
            }}
            onKeyDown={onGridKeyDown}
            onScroll={(event) => {
              // Identity-guarded: scroll events between window boundaries, overscroll bounce and
              // single-axis wheels must not re-render a few hundred cells to change nothing.
              const { scrollTop, scrollLeft } = event.currentTarget;
              setScroll((current) =>
                current.top === scrollTop && current.left === scrollLeft
                  ? current
                  : { top: scrollTop, left: scrollLeft },
              );
            }}
            onCopy={(event) => {
              if (selection.mode === 'edit') {
                return;
              }
              event.preventDefault();
              event.clipboardData.setData(
                'text/plain',
                rangeToTsv(rangeTextMap(range, items, columns), range),
              );
            }}
            onPaste={(event) => {
              if (selection.mode === 'edit') {
                return;
              }
              event.preventDefault();
              const text = event.clipboardData.getData('text/plain');
              if (text.length > 0) {
                applyPlan(
                  pastePlan(
                    { row: range.startRow, col: range.startCol },
                    parseTsv(text),
                    items,
                    columns,
                  ),
                  'taken',
                );
              }
            }}
            className={cn(
              'relative min-w-0 max-w-full overflow-auto overscroll-contain outline-none',
              SCROLLER_HEIGHT_CLASS,
              focusRingInset,
            )}
          >
            <div className="relative" role="presentation" style={canvasStyle}>
              {visibleRows.map((row) => {
                const item = items[row];
                if (item === undefined) {
                  return null;
                }
                return (
                  <div key={item.id} role="row" aria-rowindex={row + 1} className="contents">
                    {visibleCols.map((col) => {
                      const column = columns[col];
                      if (column === undefined) {
                        return null;
                      }
                      const shown = cellDisplay(item, column);
                      const isActive = row === active.row && col === active.col;
                      const inRange = !rangeIsCell && rangeContains(range, { row, col });
                      const isTitle = column.key === TITLE_COLUMN_KEY;
                      // design-token-exempt: a cell's place and size are grid geometry computed at runtime
                      const cellStyle = {
                        top: `${String(row * ROW_HEIGHT)}px`,
                        left: `${String(offsets[col] ?? 0)}px`,
                        width: `${String(widths[col] ?? 0)}px`,
                        height: `${String(ROW_HEIGHT)}px`,
                      };
                      // Justification: this grid uses aria-activedescendant, where focus stays on the
                      // role="grid" container and the active cell is only named, not focused. A
                      // tabIndex here would let Tab escape into individual cells and break that
                      // pattern.
                      return (
                        // eslint-disable-next-line jsx-a11y/interactive-supports-focus
                        <div
                          key={column.key}
                          id={cellId(gridId, { row, col })}
                          data-sheet-cell={cellKey({ row, col })}
                          role="gridcell"
                          aria-colindex={col + 1}
                          aria-selected={isActive || inRange}
                          aria-label={
                            isTitle
                              ? `${item.title || 'Untitled'}, opens the item`
                              : `${column.label} for ${item.title || 'Untitled'}${
                                  shown.length > 0 ? `, ${shown}` : ''
                                }`
                          }
                          title={shown.length > 0 ? shown : undefined}
                          onMouseDown={(event) => {
                            if (event.button !== 0) return;
                            // Mouse down rather than click so a shift-click extends the range from
                            // the pressed corner (there is no drag-selection; Shift with the arrows
                            // or a shift-click is the range gesture).
                            //
                            // Whether the grid already held focus, checked before we take it below,
                            // is what tells a tap that lands on the already-active cell apart from
                            // the tap that first brought that cell to life: the former is a person
                            // asking to edit or open what they can already see is selected, the
                            // latter is the ordinary first touch that only selects. Without this, a
                            // touch or mouse user could select a cell but never edit or open one
                            // without a double-click or the keyboard.
                            const alreadyFocused =
                              scrollerRef.current !== null &&
                              document.activeElement === scrollerRef.current;
                            event.preventDefault();
                            scrollerRef.current?.focus({ preventScroll: true });
                            // A draft that fails coercion keeps its editor open: moving the selection
                            // out from under it would throw away the typed text with the notice still
                            // claiming it can be corrected.
                            if (selection.mode === 'edit' && !commitDraft('stay')) {
                              return;
                            }
                            if (alreadyFocused && isActive && !event.shiftKey) {
                              if (isTitle) {
                                onOpen(item.id);
                              } else {
                                beginEdit('open', cellText(item, column));
                              }
                              return;
                            }
                            dispatch({ type: 'moveTo', ref: { row, col }, extend: event.shiftKey });
                            if (
                              !event.shiftKey &&
                              canEditProperty(
                                properties.find((property) => property.key === column.key),
                              ) &&
                              usesPicker(properties.find((property) => property.key === column.key))
                            ) {
                              beginEdit('open', cellText(item, column), { row, col });
                            }
                          }}
                          onDoubleClick={() => {
                            if (isTitle) {
                              onOpen(item.id);
                            } else {
                              beginEdit('open', cellText(item, column));
                            }
                          }}
                          className={cn(
                            'absolute overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-divider px-2 py-1.5 text-sm',
                            column.type === 'number' ? 'text-right' : 'text-left',
                            isTitle ? 'font-semibold' : '',
                            inRange ? gridRangeCell : '',
                            isActive ? 'outline-2 -outline-offset-2 outline-accent' : '',
                          )}
                          style={cellStyle}
                        >
                          {column.type === 'checkbox' || column.type === 'completion' ? (
                            <Icon
                              icon={item.properties[column.key] === true ? Check : Square}
                              size="sm"
                            />
                          ) : column.type === 'select' ||
                            column.type === 'priority' ||
                            column.type === 'assignee' ||
                            column.type === 'multi_select' ? (
                            <span className="flex items-center justify-between gap-1">
                              <span className="truncate">{shown}</span>
                              <Icon icon={ChevronDown} size="sm" />
                            </span>
                          ) : (
                            shown
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {selection.mode === 'edit' &&
              activeColumn !== undefined &&
              activeItem !== undefined ? (
                <CellEditor
                  ref={editorRef}
                  ariaLabel={`Edit ${activeColumn.label} for ${activeItem.title || 'Untitled'}`}
                  value={selection.draft}
                  onChange={(event) => {
                    dispatch({ type: 'setDraft', draft: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitDraft('down');
                    } else if (event.key === 'Tab') {
                      event.preventDefault();
                      commitDraft('right');
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => {
                    // A genuine click-away commits, as in every spreadsheet. This blur fires
                    // synchronously inside the cell handler's focus() call, BEFORE that handler's own
                    // commitDraft - so this is the call that commits on a click-away, and the settled
                    // flag is what keeps the cell handler's later call from committing twice.
                    if (selection.mode === 'edit') {
                      commitDraft('stay');
                    }
                  }}
                  position={editorStyle}
                />
              ) : null}
            </div>
          </div>
        )}
      </ContextMenu>

      {fillOffer === null || patternedColumn === null ? null : (
        <FillSeriesOffer
          columnLabel={patternedColumn.column.label}
          describe={patternedColumn.describe}
          preview={patternedColumn.preview}
          rows={fillOffer.rows}
          otherColumns={fillOffer.columns.length - 1}
          shortcut={formatShortcut(FILL_SERIES_SHORTCUT)}
          onFill={() => {
            fillSeries();
            setDismissedFill(rangeKey);
            scrollerRef.current?.focus({ preventScroll: true });
          }}
          onDismiss={() => {
            setDismissedFill(rangeKey);
            scrollerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      {/* Always mounted so the announcement fires the moment a sentence appears; the visible
          chrome only draws when there is something to read, so an empty region is not a stray
          rule under the grid. */}
      <Text
        variant="note"
        as="p"
        role="status"
        className={notice === null ? '' : 'border-t border-divider px-3 py-1'}
      >
        {notice}
      </Text>
    </div>
  );
}

function cellId(gridId: string, ref: CellRef): string {
  return `${gridId}-cell-${cellKey(ref)}`;
}
