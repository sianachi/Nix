import type * as Y from 'yjs';

import { type CellRef, cellKey, parseCellKey } from './refs.js';

/**
 * The sheet body's shape inside the shared Y.Doc, defined once for the editor
 * and the collaboration service. Two definitions of the same shape is the
 * failure this module exists to prevent: sheets that save on one side and
 * refuse to open on the other.
 *
 * - 'sheet-cells': Y.Map, canonical A1 key to a plain { raw } object. A cell
 *   edit replaces the whole object, so concurrent edits to one cell resolve
 *   last-write-wins - the granularity a spreadsheet user expects. An empty
 *   cell is an absent key, never a stored empty string.
 * - 'sheet-meta': Y.Map with the used extents ('rows', 'cols'), grown
 *   monotonically so the grid knows how far to scroll, and 'colWidths', a
 *   nested plain object of column letter to width step.
 *
 * The note body lives in the XmlFragment named 'default'; these keys do not
 * collide with it. A document is only ever one kind, chosen by item.type.
 */

export const SHEET_CELLS_KEY = 'sheet-cells';
export const SHEET_META_KEY = 'sheet-meta';

export interface SheetCell {
  readonly raw: string;
}

export interface SheetMeta {
  readonly rows: number;
  readonly cols: number;
  readonly colWidths: Readonly<Record<string, number>>;
}

export const DEFAULT_SHEET_META: SheetMeta = { rows: 100, cols: 26, colWidths: {} };

export function sheetCellsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(SHEET_CELLS_KEY);
}

export function sheetMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(SHEET_META_KEY);
}

/** A raw cell entry if it has the stored shape, null for anything else. */
export function readCellEntry(value: unknown): SheetCell | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>).raw;
  return typeof raw === 'string' ? { raw } : null;
}

/** Every well-formed cell as canonical key to raw text. */
export function readCells(doc: Y.Doc): Map<string, string> {
  const cells = new Map<string, string>();
  sheetCellsMap(doc).forEach((value, key) => {
    const entry = readCellEntry(value);
    if (entry !== null && parseCellKey(key) !== null) {
      cells.set(key, entry.raw);
    }
  });
  return cells;
}

export function readMeta(doc: Y.Doc): SheetMeta {
  const meta = sheetMetaMap(doc);
  const rows = meta.get('rows');
  const cols = meta.get('cols');
  const widths = meta.get('colWidths');
  const colWidths: Record<string, number> = {};
  if (typeof widths === 'object' && widths !== null && !Array.isArray(widths)) {
    for (const [letters, width] of Object.entries(widths as Record<string, unknown>)) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        colWidths[letters] = width;
      }
    }
  }
  return {
    rows:
      typeof rows === 'number' && Number.isInteger(rows) && rows > 0
        ? rows
        : DEFAULT_SHEET_META.rows,
    cols:
      typeof cols === 'number' && Number.isInteger(cols) && cols > 0
        ? cols
        : DEFAULT_SHEET_META.cols,
    colWidths,
  };
}

/**
 * Write one cell inside a transaction: text sets, empty clears, and the used
 * extents grow to keep the edited cell on the grid.
 */
export function writeCell(doc: Y.Doc, ref: CellRef, raw: string, origin?: unknown): void {
  const key = cellKey(ref);
  doc.transact(() => {
    const cells = sheetCellsMap(doc);
    if (raw.length === 0) {
      if (cells.has(key)) {
        cells.delete(key);
      }
    } else {
      cells.set(key, { raw });
    }
    growExtents(doc, ref);
  }, origin);
}

export function growExtents(doc: Y.Doc, ref: CellRef): void {
  const meta = sheetMetaMap(doc);
  const current = readMeta(doc);
  if (ref.row + 1 > current.rows) {
    meta.set('rows', ref.row + 1);
  }
  if (ref.col + 1 > current.cols) {
    meta.set('cols', ref.col + 1);
  }
}

export function setColumnWidth(doc: Y.Doc, letters: string, width: number): void {
  doc.transact(() => {
    const meta = sheetMetaMap(doc);
    const current = readMeta(doc);
    meta.set('colWidths', { ...current.colWidths, [letters]: width });
  });
}
