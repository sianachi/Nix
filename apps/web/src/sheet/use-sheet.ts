import {
  type CellRange,
  type CellRef,
  type CellValue,
  SHEET_LIMITS,
  type SheetBudgetReport,
  type SheetMeta,
  cellKey,
  evaluateSheet,
  growExtents,
  isInBounds,
  parseCellKey,
  rangeContains,
  readCells,
  readMeta,
  sheetCellsMap,
  sheetMetaMap,
  writeCell,
} from '@nix/sheet';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';

/**
 * The Y.Doc as the grid's single source of truth, adapted for React.
 *
 * No copy of the cells lives in component state: edits go into the document,
 * the document notifies, and the snapshot the grid renders from is rebuilt.
 * That is the same discipline the note editor gets from y-prosemirror, done
 * by hand because a grid has no ProseMirror to do it.
 *
 * Undo tracks only this tab's own transactions, so Ctrl+Z reverts your edit
 * and never a colleague's - the same property `yUndoPlugin` gives notes.
 */

/** The origin local edits are transacted under, so undo can tell them apart. */
export const LOCAL_ORIGIN = 'sheet-local';

export interface SheetData {
  readonly cells: ReadonlyMap<string, string>;
  readonly meta: SheetMeta;
  /** Every non-empty cell's evaluated value. */
  readonly values: ReadonlyMap<string, CellValue>;
  /**
   * Whether the last evaluation ran out of its op budget. A sheet this is
   * true for has cells reporting #LIMIT! not because anything is wrong with
   * them, but because the sheet as a whole is too expensive to finish
   * recalculating - the grid says so once, rather than leaving a screen of
   * identical codes to explain themselves.
   */
  readonly budget: SheetBudgetReport;
  readonly setCell: (ref: CellRef, raw: string) => void;
  readonly clearRange: (range: CellRange) => void;
  /** Pastes a block of raw texts with its top-left corner at `start`. */
  readonly pasteBlock: (start: CellRef, rows: readonly (readonly string[])[]) => void;
  readonly undo: () => void;
  readonly redo: () => void;
}

interface Snapshot {
  readonly cells: ReadonlyMap<string, string>;
  readonly meta: SheetMeta;
}

interface SheetStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => Snapshot;
}

function createSheetStore(doc: Y.Doc): SheetStore {
  let cached: Snapshot | null = null;
  return {
    subscribe: (onChange) => {
      const invalidate = (): void => {
        cached = null;
        onChange();
      };
      const cells = sheetCellsMap(doc);
      const meta = sheetMetaMap(doc);
      cells.observe(invalidate);
      meta.observe(invalidate);
      return () => {
        cells.unobserve(invalidate);
        meta.unobserve(invalidate);
      };
    },
    getSnapshot: () => {
      cached ??= { cells: readCells(doc), meta: readMeta(doc) };
      return cached;
    },
  };
}

export function useSheet(doc: Y.Doc): SheetData {
  const store = useMemo(() => createSheetStore(doc), [doc]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Recomputed only when the document actually changed. This is an exception
  // to the no-useMemo rule on cost grounds: a full evaluation walks every
  // formula under a 500k-op budget - fine per edit, not fine on every
  // unrelated render of the page that hosts the grid.
  const evaluation = useMemo(() => evaluateSheet({ cells: snapshot.cells }), [snapshot]);

  // The undo and redo stacks are state that cannot be rebuilt from the document, so this is
  // constructed with useState's lazy initializer, not useMemo: a discarded memo would silently
  // empty the person's undo history and leave the old manager's observers registered on the
  // maps, accumulating a second set of stack items for every edit after. `doc` is fixed for the
  // hook's lifetime - the sheet editor is remounted per item - so losing reactivity to it costs
  // nothing.
  const [undoManager] = useState(
    () =>
      new Y.UndoManager([sheetCellsMap(doc), sheetMetaMap(doc)], {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
      }),
  );

  useEffect(() => {
    return () => {
      undoManager.destroy();
    };
  }, [undoManager]);

  return useMemo<SheetData>(
    () => ({
      cells: snapshot.cells,
      meta: snapshot.meta,
      values: evaluation.values,
      budget: evaluation.budget,
      setCell: (ref, raw) => {
        writeCell(doc, ref, raw, LOCAL_ORIGIN);
      },
      clearRange: (range) => {
        doc.transact(() => {
          const cells = sheetCellsMap(doc);
          const area = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
          // Whichever side is cheaper: a small selection walks its own
          // cells directly, a selection spanning most of an empty grid
          // instead walks what is actually stored. Select-all-and-delete on
          // a lightly populated sheet must not cost the address space.
          if (area <= cells.size) {
            for (let row = range.startRow; row <= range.endRow; row += 1) {
              for (let col = range.startCol; col <= range.endCol; col += 1) {
                const key = cellKey({ row, col });
                if (cells.has(key)) {
                  cells.delete(key);
                }
              }
            }
          } else {
            const toDelete: string[] = [];
            cells.forEach((_value, key) => {
              const ref = parseCellKey(key);
              if (ref !== null && rangeContains(range, ref)) {
                toDelete.push(key);
              }
            });
            for (const key of toDelete) {
              cells.delete(key);
            }
          }
        }, LOCAL_ORIGIN);
      },
      pasteBlock: (start, rows) => {
        doc.transact(() => {
          const cells = sheetCellsMap(doc);
          let maxRow = start.row;
          let maxCol = start.col;
          let cellCount = cells.size;
          rowLoop: for (let r = 0; r < rows.length; r += 1) {
            const line = rows[r];
            if (line === undefined) {
              continue;
            }
            for (let c = 0; c < line.length; c += 1) {
              const ref = { row: start.row + r, col: start.col + c };
              // A paste larger than the sheet stops at the edge rather than
              // writing cells the server would refuse the whole update over.
              if (!isInBounds(ref, SHEET_LIMITS.maxRows, SHEET_LIMITS.maxCols)) {
                continue;
              }
              const raw = (line[c] ?? '').slice(0, SHEET_LIMITS.maxRawLength);
              const key = cellKey(ref);
              const existed = cells.has(key);
              if (raw.length === 0) {
                if (existed) {
                  cells.delete(key);
                  cellCount -= 1;
                }
                continue;
              }
              if (!existed) {
                // A paste that would push the sheet past its cell bound
                // stops here too, for the same reason.
                if (cellCount >= SHEET_LIMITS.maxCells) {
                  break rowLoop;
                }
                cellCount += 1;
              }
              cells.set(key, { raw });
              maxRow = Math.max(maxRow, ref.row);
              maxCol = Math.max(maxCol, ref.col);
            }
          }
          // Extents grow once, from the block's actual reach, rather than
          // once per cell - the difference between one meta read and one
          // per pasted cell.
          growExtents(doc, { row: maxRow, col: maxCol });
        }, LOCAL_ORIGIN);
      },
      undo: () => {
        undoManager.undo();
      },
      redo: () => {
        undoManager.redo();
      },
    }),
    [doc, evaluation, snapshot, undoManager],
  );
}
