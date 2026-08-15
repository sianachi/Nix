import {
  SHEET_COLUMN_WIDTH,
  SHEET_ERROR_HELP,
  SHEET_LIMITS,
  type CellRef,
  cellKey,
  clampColumnWidth,
  columnLetters,
  formatCellValue,
  isSheetError,
  rangeContains,
} from '@nix/sheet';
import { Text, cn, dragHandleLineStates, fieldLabel, focusRingInset, gridRangeCell } from '@nix/ui';
import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { parseTsv, rangeToTsv } from './clipboard';
import {
  COLUMN_RESIZE_STEP,
  type ResizeDrag,
  beginColumnResize,
  moveColumnResize,
} from './column-resize';
import { gridKeyAction } from './grid-keys';
import { INITIAL_SELECTION, type GridBounds, selectedRange, selectionReducer } from './selection';
import { FormulaBar } from './formula-bar';
import { fitCellText } from './overflow';
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

// The cell geometry is a fixed 32px of runtime arithmetic. The h-8/w-12
// chrome strips beside it are on the token spacing scale (which is not 4px -
// theme.css sets --spacing to 3.4px, so h-8 is 27.2px); the strips and the
// cells never need to agree on a number, only each on its own.
const ROW_HEIGHT = 32;
const DEFAULT_COLUMN_WIDTH = SHEET_COLUMN_WIDTH.default;
/** Blank rows and columns past the used extent, so there is room to type. */
const SPARE_ROWS = 40;
const SPARE_COLS = 6;

const GRID_HINT_ID = 'sheet-grid-keyboard-hint';
const RESIZE_HINT_ID = 'sheet-resize-keyboard-hint';

export function SheetGrid({ sheet }: SheetGridProps): ReactNode {
  const [selection, dispatch] = useReducer(selectionReducer, INITIAL_SELECTION);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [resize, setResize] = useState<ResizeDrag | null>(null);

  // Whether Tab is a cell movement or an exit. Escape releases the trap and any grid keystroke
  // restores it - blurring on Escape, which this replaced, sent focus to <body>, so the promised
  // "Escape, then Tab" resumed from the top of the document instead of from after the grid.
  const [trapsTab, setTrapsTab] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  // The latest pointer position and the one frame scheduled to apply it:
  // pointermove fires at the pointer's report rate (well past 60Hz on gaming
  // mice), each event its own task, so moves coalesce to one state write per
  // animation frame.
  const dragXRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);

  const bounds: GridBounds = {
    rows: Math.min(SHEET_LIMITS.maxRows, Math.max(sheet.meta.rows + SPARE_ROWS, 100)),
    cols: Math.min(SHEET_LIMITS.maxCols, Math.max(sheet.meta.cols + SPARE_COLS, 26)),
  };

  // Derived per render, deliberately unmemoized: nothing depends on these
  // arrays' identity (the reveal effect keys on scalars), and building them
  // is two walks over at most 702 columns - noise next to the cell window
  // they feed. A drag in flight previews through this same geometry, so the
  // header, the cells and the editor overlay cannot disagree about where a
  // column is mid-drag.
  const widths = new Array<number>(bounds.cols);
  for (let col = 0; col < bounds.cols; col += 1) {
    widths[col] = sheet.meta.colWidths[columnLetters(col)] ?? DEFAULT_COLUMN_WIDTH;
  }
  if (resize !== null && resize.col < bounds.cols) {
    widths[resize.col] = resize.width;
  }
  const offsets = columnOffsets(widths);
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
  // the minimum that makes it visible. Keyed on the cell's own geometry as
  // scalars, not on the geometry arrays, so it cannot fire for an unrelated
  // column's change - and suspended while a resize drag is live, or every
  // pointermove that pushes the active cell's edge past the viewport would
  // scroll the grid out from under the column being held.
  const activeTop = selection.active.row * ROW_HEIGHT;
  const activeLeft = offsets[selection.active.col] ?? 0;
  const activeWidth = widths[selection.active.col] ?? DEFAULT_COLUMN_WIDTH;
  const resizing = resize !== null;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || resizing) {
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
  }, [activeTop, activeLeft, activeWidth, resizing]);

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
      // Escape releases the Tab trap; the next Tab then leaves the grid in
      // document order, which is what the hint promises.
      event.preventDefault();
      setTrapsTab(false);
      return;
    }
    if (event.key === 'Tab' && !trapsTab) {
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
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

    // Everything else is the ladder both grids share; only what the result
    // means - what a clear clears, what text an opened edit starts from - is
    // this grid's own.
    const result = gridKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        meta,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        active: selection.active,
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
        beginEdit(result.source, result.source === 'typing' ? result.draft : activeRaw);
        return;
      case 'clear':
        sheet.clearRange(range);
    }
  }

  function stopDragFrame(): void {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    dragXRef.current = null;
  }

  // A frame scheduled by the last pointermove of a drag must not fire into an
  // unmounted grid.
  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, []);

  function onHandlePointerDown(col: number, event: ReactPointerEvent<HTMLDivElement>): void {
    // preventDefault stops the header text from being selected by the drag;
    // focus is taken explicitly instead, so the ring and the keys (Escape to
    // cancel, arrows to fine-tune) are there if the person switches
    // mid-thought.
    event.preventDefault();
    event.currentTarget.focus();
    setResize(
      beginColumnResize({
        col,
        pointerId: event.pointerId,
        clientX: event.clientX,
        width: widths[col] ?? DEFAULT_COLUMN_WIDTH,
      }),
    );
  }

  // Move, release and cancel live on the capture overlay, not the handle: the
  // handle is virtualized, so a drag that scrolls its column out of the
  // render window would unmount it mid-gesture and strand the drag with the
  // overlay swallowing every pointer event. The overlay exists exactly while
  // a drag is live and nothing can unmount it but the drag ending.
  function onOverlayPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resize?.pointerId !== event.pointerId) {
      return;
    }
    // A mouse released outside the window sends its pointerup where the
    // overlay cannot hear it, and the next move arrives with no button held.
    // Without this, the phantom drag keeps resizing and the next click
    // commits it; cancelling is the honest reading of a button nobody is
    // pressing. Touch and pen never hit it - they get implicit capture.
    if (event.buttons === 0) {
      stopDragFrame();
      setResize(null);
      return;
    }
    dragXRef.current = event.clientX;
    dragFrameRef.current ??= requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const clientX = dragXRef.current;
      if (clientX !== null) {
        setResize((drag) => (drag === null ? null : moveColumnResize(drag, clientX)));
      }
    });
  }

  function onOverlayPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resize?.pointerId !== event.pointerId) {
      return;
    }
    stopDragFrame();
    // One write on release, not one per move: the drag previews locally and
    // the shared document receives a single undoable width change. The
    // release position is authoritative - it may be newer than the last
    // frame the preview painted.
    sheet.setColumnWidth(resize.col, moveColumnResize(resize, event.clientX).width);
    setResize(null);
  }

  function onOverlayPointerCancel(): void {
    // A cancelled gesture (browser took the pointer, touch was interrupted)
    // reverts rather than committing whatever width it happened to reach.
    stopDragFrame();
    setResize(null);
  }

  /**
   * After a keyboard resize, scrolls the body the minimum that keeps the
   * column's right edge - where the focused handle sits - in view, the same
   * arithmetic the active-cell effect uses. Without it, End would park the
   * focused element past the viewport (WCAG 2.4.11).
   */
  function revealColumnEdge(col: number, width: number): void {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const left = offsets[col] ?? 0;
    const right = left + width;
    if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right - scroller.clientWidth;
    } else if (left < scroller.scrollLeft) {
      scroller.scrollLeft = left;
    }
  }

  function onHandleKeyDown(col: number, event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // The keyboard exit from a mouse-begun drag: revert, commit nothing.
      if (resize !== null) {
        event.preventDefault();
        stopDragFrame();
        setResize(null);
      }
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && (event.key === 'z' || event.key === 'Z')) {
      // The grid's undo shortcut, repeated here because the handles live in
      // the header strip, outside the scroller subtree that binds it - a
      // resize must be undoable from the very element that just made it.
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
    const width = widths[col] ?? DEFAULT_COLUMN_WIDTH;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = width - COLUMN_RESIZE_STEP;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = width + COLUMN_RESIZE_STEP;
    } else if (event.key === 'Home') {
      next = SHEET_COLUMN_WIDTH.min;
    } else if (event.key === 'End') {
      next = SHEET_COLUMN_WIDTH.max;
    }
    if (next !== null) {
      event.preventDefault();
      sheet.setColumnWidth(col, next);
      revealColumnEdge(col, clampColumnWidth(next));
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
      <p id={RESIZE_HINT_ID} className="sr-only">
        Arrow keys resize the column. Home and End set the narrowest and widest widths.
      </p>

      <div className="relative min-h-0 flex-1">
        {/* The drag surface: it owns move, release and cancel (see the
            handler comments for why the handle must not), keeps the resize
            cursor everywhere the pointer goes, and keeps hover states under
            it from firing. */}
        {resize !== null ? (
          <div
            aria-hidden="true"
            onPointerMove={onOverlayPointerMove}
            onPointerUp={onOverlayPointerUp}
            onPointerCancel={onOverlayPointerCancel}
            className="fixed inset-0 z-40 cursor-col-resize touch-none select-none"
          />
        ) : null}

        {/* Corner above the row numbers, beside the column letters. */}
        <div
          aria-hidden="true"
          className="absolute left-0 top-0 z-30 h-8 w-12 border-b border-r border-divider bg-surface"
        />

        {/* Column letters, pinned vertically, following horizontal scroll. */}
        <div className="absolute left-12 right-0 top-0 z-20 h-8 overflow-hidden border-b border-divider bg-surface">
          <div className="relative h-8" style={columnStripStyle}>
            {visibleCols.map((col) => {
              const width = widths[col] ?? DEFAULT_COLUMN_WIDTH;
              // design-token-exempt: a column's place and width are grid geometry computed at runtime
              const style = {
                left: `${String(offsets[col] ?? 0)}px`,
                width: `${String(width)}px`,
              };
              // design-token-exempt: the handle sits on the column's right edge, grid geometry computed at runtime
              const handleStyle = { left: `${String(offsets[col + 1] ?? 0)}px` };
              return (
                <Fragment key={col}>
                  <div
                    className={cn(
                      'absolute top-0 flex h-8 items-center justify-center border-r border-divider',
                      fieldLabel,
                    )}
                    style={style}
                  >
                    {columnLetters(col)}
                  </div>
                  {/* A focusable window-splitter separator: drag it, or focus
                      it and use the arrow keys - the resize must not be a
                      pointer-only act. Tab reaches only the active column's
                      handle (a stable single stop where the person already
                      is, instead of one stop per visible column); arrows
                      resize once focused. The 12px strip is the hit area,
                      the inner line is the visual. */}
                  {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions --
                      Justification: ARIA defines a focusable separator with
                      aria-valuenow as the window-splitter widget; jsx-a11y
                      models separator only as the static divider. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize column ${columnLetters(col)}`}
                    aria-valuenow={width}
                    aria-valuemin={SHEET_COLUMN_WIDTH.min}
                    aria-valuemax={SHEET_COLUMN_WIDTH.max}
                    aria-valuetext={`${String(width)} pixels`}
                    aria-describedby={RESIZE_HINT_ID}
                    tabIndex={col === selection.active.col ? 0 : -1}
                    data-dragging={resize?.col === col ? '' : undefined}
                    onPointerDown={(event) => {
                      onHandlePointerDown(col, event);
                    }}
                    onKeyDown={(event) => {
                      onHandleKeyDown(col, event);
                    }}
                    className={`group absolute top-0 z-10 h-8 w-3 -translate-x-1/2 cursor-col-resize touch-none ${focusRingInset}`}
                    style={handleStyle}
                  >
                    <span
                      aria-hidden="true"
                      // `w-px`, the one hairline weight every drag handle in the product draws -
                      // this used to be `w-0.5`, which read as a heavier rule than the pane
                      // divider's beside it for no reason anybody chose. See
                      // `dragHandleLineStates`.
                      className={`pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${dragHandleLineStates}`}
                    />
                  </div>
                  {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions */}
                </Fragment>
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
          className={`absolute bottom-0 left-12 right-0 top-8 overflow-auto outline-none ${focusRingInset}`}
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
                  const width = widths[col] ?? DEFAULT_COLUMN_WIDTH;
                  // A number that does not fit shows hash marks, never a
                  // digit prefix that reads as a smaller number. The label
                  // keeps the real value, so assistive technology hears it
                  // and the hover reveals it.
                  const shown = fitCellText(display, numeric, width);
                  const overflowed = shown !== display;
                  // The hover disclosure, most specific first: a hashed
                  // formula cell shows its value and its formula, a hashed
                  // literal its value, a fitting formula its raw text.
                  let titleText: string | undefined;
                  if (overflowed) {
                    titleText =
                      raw !== undefined && raw !== display ? `${display} (${raw})` : display;
                  } else if (raw !== undefined && raw !== display) {
                    titleText = raw;
                  }
                  // design-token-exempt: a cell's place and size are grid geometry computed at runtime
                  const cellStyle = {
                    top: `${String(row * ROW_HEIGHT)}px`,
                    left: `${String(offsets[col] ?? 0)}px`,
                    width: `${String(width)}px`,
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
                      title={titleText}
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
                      // px-2 here is the box overflow.ts's
                      // CELL_HORIZONTAL_PADDING describes - change both.
                      className={`absolute overflow-hidden text-ellipsis border-b border-r border-divider px-2 py-1.5 text-sm whitespace-nowrap ${
                        numeric ? 'text-right' : 'text-left'
                      } ${failed ? 'font-semibold underline decoration-dotted decoration-2' : ''} ${
                        inRange ? gridRangeCell : ''
                      } ${isActive ? 'outline-2 -outline-offset-2 outline-accent' : ''}`}
                      style={cellStyle}
                    >
                      {shown}
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
      <Text
        variant="caption"
        as="p"
        aria-live="polite"
        className="shrink-0 border-t border-divider px-3 py-1"
      >
        {(() => {
          const value = sheet.values.get(activeKey);
          if (value === undefined || !isSheetError(value)) {
            return null;
          }
          return `${activeKey}: ${value.error} — ${SHEET_ERROR_HELP[value.error]}`;
        })()}
      </Text>
    </div>
  );
}
