import {
  SHEET_ERROR_HELP,
  SHEET_LIMITS,
  type CellRef,
  cellKey,
  columnLetters,
  formatCellValue,
  isSheetError,
  rangeContains,
} from '@nix/sheet';
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { parseTsv, rangeToTsv } from './clipboard';
import { INITIAL_SELECTION, type GridBounds, selectedRange, selectionReducer } from './selection';
import { FormulaBar } from './formula-bar';
import { type SheetData } from './use-sheet';
import { columnOffsets, columnWindow, rowWindow } from './windowing';

/**
 * The grid: windowed rendering, one selection model, edits committed to the
 * shared document.
 *
 * **Only the visible slice of the grid exists in the DOM.** Ten thousand
 * rows are the sheet's normal case, not its pathological one, so the DOM
 * holds the window plus overscan and the rest is two spacer dimensions.
 * `aria-rowcount`/`aria-colcount` with per-cell indices tell assistive
 * technology about the cells that are not rendered.
 *
 * **Focus stays on the grid container**, which names the active cell through
 * `aria-activedescendant`. Roving tabindex would put focus on a cell element
 * that virtualization is allowed to unmount mid-keystroke; the container
 * cannot be unmounted and the pattern is equally supported.
 *
 * **Tab moves the active cell, so Escape is the way out.** Overriding Tab is
 * the incumbents' own convention and the one a spreadsheet's own keyboard
 * habits expect, but it is a trap without a stated exit - `aria-describedby`
 * says so for anyone who reaches the grid without a mouse.
 */

export interface SheetGridProps {
  readonly sheet: SheetData;
}

// Geometry the windowing arithmetic and the utility classes must agree on:
// h-8 is 32px and w-12 is 48px on the default 4px spacing scale. Stated once
// here; the classes below are the tokens' spelling of the same numbers.
const ROW_HEIGHT = 32;
const DEFAULT_COLUMN_WIDTH = 128;
/** Blank rows and columns past the used extent, so there is room to type. */
const SPARE_ROWS = 40;
const SPARE_COLS = 6;

const GRID_HINT_ID = 'sheet-grid-keyboard-hint';

export function SheetGrid({ sheet }: SheetGridProps): ReactNode {
  const [selection, dispatch] = useReducer(selectionReducer, INITIAL_SELECTION);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);

  const bounds: GridBounds = {
    rows: Math.min(SHEET_LIMITS.maxRows, Math.max(sheet.meta.rows + SPARE_ROWS, 100)),
    cols: Math.min(SHEET_LIMITS.maxCols, Math.max(sheet.meta.cols + SPARE_COLS, 26)),
  };

  const widths = useMemo(() => {
    const list = new Array<number>(bounds.cols);
    for (let col = 0; col < bounds.cols; col += 1) {
      list[col] = sheet.meta.colWidths[columnLetters(col)] ?? DEFAULT_COLUMN_WIDTH;
    }
    return list;
  }, [bounds.cols, sheet.meta.colWidths]);
  const offsets = useMemo(() => columnOffsets(widths), [widths]);
  const totalWidth = offsets[bounds.cols] ?? 0;
  const totalHeight = bounds.rows * ROW_HEIGHT;

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

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, []);

  // The active cell is kept on screen the way a caret is: moving it scrolls
  // the minimum that makes it visible.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const top = selection.active.row * ROW_HEIGHT;
    const left = offsets[selection.active.col] ?? 0;
    const width = widths[selection.active.col] ?? DEFAULT_COLUMN_WIDTH;
    if (top < scroller.scrollTop) {
      scroller.scrollTop = top;
    } else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    }
    if (left < scroller.scrollLeft) {
      scroller.scrollLeft = left;
    } else if (left + width > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = left + width - scroller.clientWidth;
    }
  }, [offsets, selection.active, widths]);

  useEffect(() => {
    // Editing via the formula bar keeps focus there; the overlay only takes
    // focus for an edit that began in the grid itself, or the bar would lose
    // the keystroke that just opened it.
    if (selection.mode === 'edit' && selection.editSource !== 'bar') {
      editorRef.current?.focus();
      // Opening an existing value places the caret at the end; typing over
      // replaced the text already, so the end is right for both.
      editorRef.current?.setSelectionRange(selection.draft.length, selection.draft.length);
    }
    // Justification: this runs once per entry into edit mode, to place the caret. Reacting to
    // selection.draft.length too would reset the caret to the end on every keystroke, undoing
    // whatever the person just typed in the middle of the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.mode, selection.editSource]);

  const activeKey = cellKey(selection.active);
  const activeRaw = sheet.cells.get(activeKey) ?? '';
  const range = selectedRange(selection);
  const rangeIsCell = range.startRow === range.endRow && range.startCol === range.endCol;

  function commitDraft(then: 'down' | 'right' | 'stay'): void {
    if (selection.mode !== 'edit') {
      return;
    }
    const raw = selection.draft.slice(0, SHEET_LIMITS.maxRawLength);
    if (raw !== activeRaw) {
      sheet.setCell(selection.active, raw);
    }
    dispatch({ type: 'commit', then, bounds });
    scrollerRef.current?.focus();
  }

  function cancelEdit(): void {
    dispatch({ type: 'cancel' });
    scrollerRef.current?.focus();
  }

  function beginEdit(source: 'typing' | 'open' | 'bar', draft: string): void {
    dispatch({ type: 'startEdit', draft, source });
  }

  function isOccupied(ref: CellRef): boolean {
    return sheet.cells.has(cellKey(ref));
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (selection.mode === 'edit') {
      return;
    }
    if (event.key === 'Escape') {
      // Tab is repurposed for cell movement below, so Escape is the only way
      // out of the grid for a keyboard-only visitor - it must exist, and it
      // must actually move focus rather than merely deselecting.
      event.preventDefault();
      scrollerRef.current?.blur();
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    const arrows: Record<string, readonly [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      const [dRow, dCol] = arrow;
      if (meta) {
        dispatch({ type: 'jump', dRow, dCol, extend: event.shiftKey, bounds, isOccupied });
      } else {
        dispatch({ type: 'move', dRow, dCol, extend: event.shiftKey, bounds });
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      dispatch({ type: 'move', dRow: 0, dCol: event.shiftKey ? -1 : 1, extend: false, bounds });
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      beginEdit('open', activeRaw);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      sheet.clearRange(range);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      dispatch({
        type: 'moveTo',
        ref: { row: meta ? 0 : selection.active.row, col: 0 },
        extend: event.shiftKey,
      });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      dispatch({
        type: 'moveTo',
        ref: { row: meta ? bounds.rows - 1 : selection.active.row, col: bounds.cols - 1 },
        extend: event.shiftKey,
      });
      return;
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const page = Math.max(1, Math.floor(viewport.height / ROW_HEIGHT) - 1);
      dispatch({
        type: 'move',
        dRow: event.key === 'PageDown' ? page : -page,
        dCol: 0,
        extend: event.shiftKey,
        bounds,
      });
      return;
    }
    if (meta && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      if (event.shiftKey) {
        sheet.redo();
      } else {
        sheet.undo();
      }
      return;
    }
    if (meta && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      sheet.redo();
      return;
    }
    // A printable character starts an edit that replaces the cell. Copy and
    // paste arrive as clipboard events, not here. isComposing is checked so
    // the first keystroke of an IME composition (Japanese, Chinese, Korean)
    // does not open an edit with a stray character already in it.
    if (!meta && !event.nativeEvent.isComposing && event.key.length === 1) {
      event.preventDefault();
      beginEdit('typing', event.key);
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

  // design-token-exempt: the header strips mirror the body's scroll position and extent, runtime values with no token to draw from
  const columnStripStyle = {
    width: `${String(totalWidth)}px`,
    transform: `translateX(-${String(scroll.left)}px)`,
  };
  const rowStripStyle = {
    height: `${String(totalHeight)}px`,
    transform: `translateY(-${String(scroll.top)}px)`,
  };
  // design-token-exempt: the editor overlays the active cell, whose place is runtime geometry
  const editorStyle = {
    top: `${String(selection.active.row * ROW_HEIGHT)}px`,
    left: `${String(offsets[selection.active.col] ?? 0)}px`,
    width: `${String(widths[selection.active.col] ?? DEFAULT_COLUMN_WIDTH)}px`,
    height: `${String(ROW_HEIGHT)}px`,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FormulaBar
        active={selection.active}
        text={selection.mode === 'edit' ? selection.draft : activeRaw}
        editing={selection.mode === 'edit'}
        onBeginEdit={() => {
          beginEdit('bar', activeRaw);
        }}
        onChange={(draft) => {
          dispatch({ type: 'setDraft', draft });
        }}
        onCommit={() => {
          commitDraft('down');
        }}
        onCancel={cancelEdit}
      />

      <p id={GRID_HINT_ID} className="sr-only">
        Arrow keys move the active cell. Tab and Shift+Tab move it too, rather than leaving the
        grid. Press Escape, then Tab, to move focus out of the grid.
      </p>

      <div className="relative min-h-0 flex-1">
        {/* Corner above the row numbers, beside the column letters. */}
        <div
          aria-hidden="true"
          className="absolute left-0 top-0 z-30 h-8 w-12 border-b border-r border-divider bg-surface"
        />

        {/* Column letters, pinned vertically, following horizontal scroll. */}
        <div className="absolute left-12 right-0 top-0 z-20 h-8 overflow-hidden border-b border-divider bg-surface">
          <div className="relative h-8" style={columnStripStyle}>
            {visibleCols.map((col) => {
              // design-token-exempt: a column's place and width are grid geometry computed at runtime
              const style = {
                left: `${String(offsets[col] ?? 0)}px`,
                width: `${String(widths[col] ?? DEFAULT_COLUMN_WIDTH)}px`,
              };
              return (
                <div
                  key={col}
                  className="absolute top-0 flex h-8 items-center justify-center border-r border-divider font-heading text-xs uppercase tracking-wider text-muted"
                  style={style}
                >
                  {columnLetters(col)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Row numbers, pinned horizontally, following vertical scroll. */}
        <div className="absolute bottom-0 left-0 top-8 z-20 w-12 overflow-hidden border-r border-divider bg-surface">
          <div className="relative w-12" style={rowStripStyle}>
            {visibleRows.map((row) => (
              <div
                key={row}
                className="absolute left-0 flex w-12 items-center justify-center border-b border-divider text-xs text-muted"
                style={{ top: `${String(row * ROW_HEIGHT)}px`, height: `${String(ROW_HEIGHT)}px` }} // design-token-exempt: a row's place is grid geometry computed at runtime
              >
                {row + 1}
              </div>
            ))}
          </div>
        </div>

        {/* The body: the one real scroller, and the keyboard's home. */}
        <div
          ref={scrollerRef}
          role="grid"
          aria-label="Spreadsheet"
          aria-describedby={GRID_HINT_ID}
          aria-rowcount={bounds.rows}
          aria-colcount={bounds.cols}
          aria-activedescendant={selection.mode === 'edit' ? undefined : `sheet-cell-${activeKey}`}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={onGridKeyDown}
          onScroll={(event) => {
            setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft });
          }}
          onCopy={(event) => {
            if (selection.mode === 'edit') {
              return;
            }
            event.preventDefault();
            event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
          }}
          onCut={(event) => {
            if (selection.mode === 'edit') {
              return;
            }
            event.preventDefault();
            event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
            sheet.clearRange(range);
          }}
          onPaste={(event) => {
            if (selection.mode === 'edit') {
              return;
            }
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain');
            if (text.length > 0) {
              sheet.pasteBlock({ row: range.startRow, col: range.startCol }, parseTsv(text));
            }
          }}
          className="absolute bottom-0 left-12 right-0 top-8 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <div
            className="relative"
            role="presentation"
            style={{ width: `${String(totalWidth)}px`, height: `${String(totalHeight)}px` }} // design-token-exempt: the scrollable canvas is sized by the grid's own extent, a runtime value
          >
            {visibleRows.map((row) => (
              <div key={row} role="row" aria-rowindex={row + 1} className="contents">
                {visibleCols.map((col) => {
                  const key = cellKey({ row, col });
                  const value = sheet.values.get(key);
                  const display = value === undefined ? '' : formatCellValue(value);
                  const failed = value !== undefined && isSheetError(value);
                  const raw = sheet.cells.get(key);
                  const inRange = !rangeIsCell && rangeContains(range, { row, col });
                  const isActive = row === selection.active.row && col === selection.active.col;
                  const numeric = typeof value === 'number';
                  // design-token-exempt: a cell's place and size are grid geometry computed at runtime
                  const cellStyle = {
                    top: `${String(row * ROW_HEIGHT)}px`,
                    left: `${String(offsets[col] ?? 0)}px`,
                    width: `${String(widths[col] ?? DEFAULT_COLUMN_WIDTH)}px`,
                    height: `${String(ROW_HEIGHT)}px`,
                  };
                  // Justification: this grid uses aria-activedescendant, where focus stays on the
                  // role="grid" container and the active cell is only named, not focused. A
                  // tabIndex here would let Tab escape into individual cells and break that
                  // pattern.
                  return (
                    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
                    <div
                      key={col}
                      id={`sheet-cell-${key}`}
                      role="gridcell"
                      aria-colindex={col + 1}
                      aria-selected={isActive || inRange}
                      aria-label={`${key}${display.length > 0 ? `, ${display}` : ''}`}
                      title={raw !== undefined && raw !== display ? raw : undefined}
                      onMouseDown={(event) => {
                        // Mouse down rather than click, so a drag begins a
                        // range from the right corner; shift-click extends.
                        event.preventDefault();
                        scrollerRef.current?.focus();
                        if (selection.mode === 'edit') {
                          commitDraft('stay');
                        }
                        dispatch({ type: 'moveTo', ref: { row, col }, extend: event.shiftKey });
                      }}
                      onDoubleClick={() => {
                        beginEdit('open', raw ?? '');
                      }}
                      className={`absolute overflow-hidden border-b border-r border-divider px-2 py-1.5 text-sm whitespace-nowrap ${
                        numeric ? 'text-right' : 'text-left'
                      } ${failed ? 'font-semibold underline decoration-dotted decoration-2' : ''} ${
                        inRange ? 'bg-accent/10' : ''
                      } ${isActive ? 'outline-2 -outline-offset-2 outline-accent' : ''}`}
                      style={cellStyle}
                    >
                      {display}
                    </div>
                  );
                })}
              </div>
            ))}

            {selection.mode === 'edit' && selection.editSource !== 'bar' ? (
              <input
                ref={editorRef}
                aria-label={`Edit cell ${activeKey}`}
                value={selection.draft}
                maxLength={SHEET_LIMITS.maxRawLength}
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
                  // Clicking elsewhere commits, as in every spreadsheet; the
                  // cell handler that took the click has already done so via
                  // commitDraft when it saw edit mode.
                  if (selection.mode === 'edit') {
                    commitDraft('stay');
                  }
                }}
                className="absolute z-10 bg-background px-2 py-1.5 text-sm outline-2 -outline-offset-2 outline-accent"
                style={editorStyle}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Always mounted, so a screen reader announces the text the moment it
          appears rather than missing a region that arrived with content
          already in it. */}
      <p aria-live="polite" className="shrink-0 border-t border-divider px-3 py-1 text-xs">
        {(() => {
          const value = sheet.values.get(activeKey);
          if (value === undefined || !isSheetError(value)) {
            return null;
          }
          return `${activeKey}: ${value.error} — ${SHEET_ERROR_HELP[value.error]}`;
        })()}
      </p>
    </div>
  );
}
