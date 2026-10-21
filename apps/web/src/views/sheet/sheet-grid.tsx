import {
  SHEET_COLUMN_WIDTH,
  SHEET_ERROR_HELP,
  SHEET_LIMITS,
  type CellRef,
  cellKey,
  columnLetters,
  isSheetError,
  parseCellKey,
  rangeContains,
} from '@nix/sheet';
import { ContextMenu, Text, focusRingInset } from '@nix/ui';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { pickRowHeight } from '../spreadsheet/grid-geometry';
import { CellEditor } from './cell-editor';
import { parseTsv, rangeToTsv } from './clipboard';
import { gridKeyAction } from './grid-keys';
import { INITIAL_SELECTION, type GridBounds, selectedRange, selectionReducer } from './selection';
import { FormulaBar } from './formula-bar';
import { SheetCell } from './sheet-cell';
import { RESIZE_HINT_ID, SheetColumnHeader } from './sheet-column-header';
import { useColumnResize } from './use-column-resize';
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

// The cell geometry is runtime arithmetic: 32px, or 44px on a coarse pointer (`pickRowHeight`). The
// h-8/w-12 chrome strips beside it are on the token spacing scale (which is not 4px -
// theme.css sets --spacing to 3.4px, so h-8 is 27.2px); the strips and the
// cells never need to agree on a number, only each on its own.
const DEFAULT_COLUMN_WIDTH = SHEET_COLUMN_WIDTH.default;
/** Blank rows and columns past the used extent, so there is room to type. */
const SPARE_ROWS = 40;
const SPARE_COLS = 6;

const GRID_HINT_ID = 'sheet-grid-keyboard-hint';

export function SheetGrid({ sheet }: SheetGridProps): ReactNode {
  const [selection, dispatch] = useReducer(selectionReducer, INITIAL_SELECTION);
  const [rowHeight] = useState(pickRowHeight);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const {
    resize,
    cancelResize,
    onHandlePointerDown,
    onOverlayPointerMove,
    onOverlayPointerUp,
    onOverlayPointerCancel,
  } = useColumnResize(sheet);

  // Whether Tab is a cell movement or an exit. Escape releases the trap and any grid keystroke
  // restores it - blurring on Escape, which this replaced, sent focus to <body>, so the promised
  // "Escape, then Tab" resumed from the top of the document instead of from after the grid.
  const [trapsTab, setTrapsTab] = useState(true);
  // What the last copy, cut or paste did, announced politely; cleared by the next key or tap.
  const [notice, setNotice] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const menuCellRef = useRef<CellRef | null>(null);
  const editSettledRef = useRef(false);

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
  const totalHeight = bounds.rows * rowHeight;

  const rows = rowWindow({
    scrollTop: scroll.top,
    viewportHeight: viewport.height,
    rowHeight: rowHeight,
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
  const activeTop = selection.active.row * rowHeight;
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
    } else if (activeTop + rowHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = activeTop + rowHeight - scroller.clientHeight;
    }
    if (activeLeft < scroller.scrollLeft) {
      scroller.scrollLeft = activeLeft;
    } else if (activeLeft + activeWidth > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = activeLeft + activeWidth - scroller.clientWidth;
    }
  }, [activeTop, activeLeft, activeWidth, resizing, rowHeight]);

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
  const rangeLabel = rangeIsCell
    ? activeKey
    : `${cellKey({ row: range.startRow, col: range.startCol })}:${cellKey({ row: range.endRow, col: range.endCol })}`;

  function commitDraft(then: 'down' | 'right' | 'stay'): void {
    if (selection.mode !== 'edit' || editSettledRef.current) {
      return;
    }
    editSettledRef.current = true;
    const raw = selection.draft.slice(0, SHEET_LIMITS.maxRawLength);
    if (raw !== activeRaw) {
      sheet.setCell(selection.active, raw);
    }
    dispatch({ type: 'commit', then, bounds });
    scrollerRef.current?.focus({ preventScroll: true });
  }

  function cancelEdit(): void {
    editSettledRef.current = true;
    dispatch({ type: 'cancel' });
    scrollerRef.current?.focus({ preventScroll: true });
  }

  function beginEdit(source: 'typing' | 'open' | 'bar', draft: string): void {
    editSettledRef.current = false;
    dispatch({ type: 'startEdit', draft, source });
  }

  function isOccupied(ref: CellRef): boolean {
    return sheet.cells.has(cellKey(ref));
  }

  function captureMenuCell(target: EventTarget | null): void {
    menuCellRef.current =
      target instanceof Element
        ? parseCellKey(target.closest('[data-sheet-cell]')?.getAttribute('data-sheet-cell') ?? '')
        : null;
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    setNotice('');
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
        pageRows: Math.max(1, Math.floor(viewport.height / rowHeight) - 1),
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

  function onCellMouseDown(
    row: number,
    col: number,
    raw: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ): void {
    if (event.button !== 0) return;
    setNotice('');
    // Mouse down rather than click, so a drag begins a range from the right corner;
    // shift-click extends.
    //
    // Checked before we take focus below: a tap that lands on a cell the grid already had
    // focused and active is a request to edit it, the same door the double-click and Enter
    // already open - without it, a touch user could select a cell but never edit one without a
    // keyboard or a double-tap.
    const alreadyFocused =
      scrollerRef.current !== null && document.activeElement === scrollerRef.current;
    event.preventDefault();
    scrollerRef.current?.focus({ preventScroll: true });
    if (selection.mode === 'edit') {
      commitDraft('stay');
    }
    if (
      alreadyFocused &&
      !event.shiftKey &&
      row === selection.active.row &&
      col === selection.active.col
    ) {
      beginEdit('open', raw);
      return;
    }
    dispatch({ type: 'moveTo', ref: { row, col }, extend: event.shiftKey });
  }

  const visibleRows: number[] = [];
  for (let row = rows.first; row <= rows.last; row += 1) {
    visibleRows.push(row);
  }
  const visibleCols: number[] = [];
  for (let col = cols.first; col <= cols.last; col += 1) {
    visibleCols.push(col);
  }

  const rowStripStyle = {
    height: `${String(totalHeight)}px`,
    transform: `translateY(-${String(scroll.top)}px)`,
  };
  // design-token-exempt: the editor overlays the active cell, whose place is runtime geometry
  const editorStyle = {
    top: `${String(selection.active.row * rowHeight)}px`,
    left: `${String(offsets[selection.active.col] ?? 0)}px`,
    width: `${String(widths[selection.active.col] ?? DEFAULT_COLUMN_WIDTH)}px`,
    height: `${String(rowHeight)}px`,
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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

      <div className="relative min-h-0 min-w-0 flex-1">
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

        <SheetColumnHeader
          sheet={sheet}
          scrollerRef={scrollerRef}
          visibleCols={visibleCols}
          widths={widths}
          offsets={offsets}
          totalWidth={totalWidth}
          scrollLeft={scroll.left}
          activeCol={selection.active.col}
          resizingCol={resize?.col ?? null}
          defaultWidth={DEFAULT_COLUMN_WIDTH}
          dragging={resize !== null}
          onCancelResize={cancelResize}
          onHandlePointerDown={onHandlePointerDown}
        />

        {/* Row numbers, pinned horizontally, following vertical scroll. */}
        <div className="absolute bottom-0 left-0 top-8 z-20 w-12 overflow-hidden border-r border-divider bg-surface">
          <div className="relative w-12" style={rowStripStyle}>
            {visibleRows.map((row) => (
              <div
                key={row}
                aria-hidden="true"
                className="absolute left-0 flex w-12 items-center justify-center border-b border-divider text-xs text-muted"
                style={{ top: `${String(row * rowHeight)}px`, height: `${String(rowHeight)}px` }} // design-token-exempt: a row's place is grid geometry computed at runtime
              >
                {row + 1}
              </div>
            ))}
          </div>
        </div>

        {/* The body: the one real scroller, and the keyboard's home. */}
        <ContextMenu
          label="Spreadsheet cell actions"
          items={() => {
            const ref = menuCellRef.current ?? selection.active;
            const key = cellKey(ref);
            return [
              {
                label: `Edit ${key}`,
                onSelect: () => {
                  commitDraft('stay');
                  dispatch({ type: 'moveTo', ref, extend: false });
                  beginEdit('open', sheet.cells.get(key) ?? '');
                },
              },
              {
                label: `Clear ${key}`,
                disabled: !sheet.cells.has(key),
                onSelect: () => {
                  commitDraft('stay');
                  sheet.setCell(ref, '');
                  dispatch({ type: 'moveTo', ref, extend: false });
                },
              },
              { label: 'Undo', onSelect: sheet.undo },
              { label: 'Redo', onSelect: sheet.redo },
            ];
          }}
        >
          {(target) => (
            <div
              {...target}
              ref={scrollerRef}
              role="grid"
              aria-label="Spreadsheet"
              aria-describedby={GRID_HINT_ID}
              aria-rowcount={bounds.rows}
              aria-colcount={bounds.cols}
              aria-activedescendant={
                selection.mode === 'edit' ? undefined : `sheet-cell-${activeKey}`
              }
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
                setScroll({
                  top: event.currentTarget.scrollTop,
                  left: event.currentTarget.scrollLeft,
                });
              }}
              onCopy={(event) => {
                if (selection.mode === 'edit') {
                  return;
                }
                event.preventDefault();
                event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
                setNotice(`Copied ${rangeLabel}`);
              }}
              onCut={(event) => {
                if (selection.mode === 'edit') {
                  return;
                }
                event.preventDefault();
                event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
                sheet.clearRange(range);
                setNotice(`Cut ${rangeLabel}`);
              }}
              onPaste={(event) => {
                if (selection.mode === 'edit') {
                  return;
                }
                event.preventDefault();
                const text = event.clipboardData.getData('text/plain');
                if (text.length > 0) {
                  sheet.pasteBlock({ row: range.startRow, col: range.startCol }, parseTsv(text));
                  setNotice(`Pasted at ${cellKey({ row: range.startRow, col: range.startCol })}`);
                }
              }}
              className={`absolute bottom-0 left-12 right-0 top-8 overflow-auto overscroll-contain outline-none ${focusRingInset}`}
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
                      const raw = sheet.cells.get(key);
                      return (
                        <SheetCell
                          key={col}
                          cellKey={key}
                          col={col}
                          value={sheet.values.get(key)}
                          raw={raw}
                          top={row * rowHeight}
                          left={offsets[col] ?? 0}
                          width={widths[col] ?? DEFAULT_COLUMN_WIDTH}
                          height={rowHeight}
                          inRange={!rangeIsCell && rangeContains(range, { row, col })}
                          isActive={row === selection.active.row && col === selection.active.col}
                          onMouseDown={(event) => {
                            onCellMouseDown(row, col, raw ?? '', event);
                          }}
                          onDoubleClick={() => {
                            beginEdit('open', raw ?? '');
                          }}
                        />
                      );
                    })}
                  </div>
                ))}

                {selection.mode === 'edit' && selection.editSource !== 'bar' ? (
                  <CellEditor
                    ref={editorRef}
                    ariaLabel={`Edit cell ${activeKey}`}
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
                    position={editorStyle}
                  />
                ) : null}
              </div>
            </div>
          )}
        </ContextMenu>
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
            return notice;
          }
          return `${activeKey}: ${value.error} — ${SHEET_ERROR_HELP[value.error]}`;
        })()}
      </Text>
    </div>
  );
}
