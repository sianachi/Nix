import type { LossSink } from '@nix/export';
import { cellKey, columnLetters, evaluateSheet, formatCellValue, parseCellKey } from '@nix/sheet';

import type { PdfNode } from './content.js';

/**
 * A spreadsheet body, as a table of what the cells show.
 *
 * **Values, not formulas, and that is the loss.** The stored body holds each cell's raw text, so a
 * formula cell says `=SUM(A1:A9)` on disk. That is right for rebuilding and wrong for reading, so
 * the grid is put through `@nix/sheet`'s own engine - the same one the editor runs, so the number
 * on paper is the number on screen rather than one this package worked out its own way - and the
 * substitution is recorded every time rather than mentioned once in a footnote.
 */

/** What a page can carry before the grid stops being readable rather than merely large. */
const PAGE_LIMITS = { columns: 8, rows: 40 } as const;

export function sheetTable(body: unknown, loss: LossSink): PdfNode | null {
  const cells = readCells(body);
  if (cells === null || cells.size === 0) {
    return null;
  }

  const extent = extentOf(cells);
  if (extent === null) {
    return null;
  }

  loss.note(
    'formula-flattened',
    'A spreadsheet is shown as the values it worked out, not the formulas behind them.',
  );

  const { values } = evaluateSheet({ cells });

  const columns = Math.min(extent.columns, PAGE_LIMITS.columns);
  const rows = Math.min(extent.rows, PAGE_LIMITS.rows);

  if (columns < extent.columns || rows < extent.rows) {
    loss.note(
      'sheet-truncated',
      `Only the first ${String(columns)} columns and ${String(rows)} rows of a spreadsheet fit on the page; it has ${String(extent.columns)} by ${String(extent.rows)}.`,
    );
  }

  // A blank corner cell so the column letters sit over the values rather than over the row numbers,
  // which is how the grid reads in the editor.
  const header: PdfNode[] = [{ text: '' }];
  for (let col = 0; col < columns; col += 1) {
    header.push({ text: columnLetters(col), style: 'tableHeader' });
  }

  const table: PdfNode[][] = [header];

  for (let row = 0; row < rows; row += 1) {
    const line: PdfNode[] = [{ text: String(row + 1), style: 'tableHeader' }];

    for (let col = 0; col < columns; col += 1) {
      const value = values.get(cellKey({ row, col }));
      line.push({ text: value === undefined ? '' : formatCellValue(value) });
    }

    table.push(line);
  }

  return {
    table: {
      widths: ['auto', ...Array.from({ length: columns }, () => '*')],
      headerRows: 1,
      body: table,
    },
    layout: 'grid',
    margin: [0, 4, 0, 10],
  };
}

/**
 * The cell map out of a stored sheet body.
 *
 * Read defensively rather than through `@nix/sheet`'s document reader: that one wants a live
 * `Y.Doc`, and what an archive carries is the JSON `sheetStrategy.materialize` wrote from one.
 * Cells are stored as `{ raw }`, and a cell that is not is skipped rather than crashing the export.
 */
function readCells(body: unknown): ReadonlyMap<string, string> | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const cells = (body as { cells?: unknown }).cells;
  if (typeof cells !== 'object' || cells === null) {
    return null;
  }

  const raw = new Map<string, string>();

  for (const [key, cell] of Object.entries(cells as Record<string, unknown>)) {
    if (typeof cell === 'object' && cell !== null) {
      const text = (cell as { raw?: unknown }).raw;
      if (typeof text === 'string' && text.length > 0) {
        raw.set(key, text);
      }
    }
  }

  return raw;
}

function extentOf(cells: ReadonlyMap<string, string>): { columns: number; rows: number } | null {
  let columns = 0;
  let rows = 0;

  for (const key of cells.keys()) {
    const reference = parseCellKey(key);
    if (reference === null) {
      continue;
    }

    columns = Math.max(columns, reference.col + 1);
    rows = Math.max(rows, reference.row + 1);
  }

  return columns === 0 || rows === 0 ? null : { columns, rows };
}
