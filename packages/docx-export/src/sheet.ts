import { PRINT_PALETTE } from '@nix/design-tokens/print';
import type { LossSink } from '@nix/export';
import { cellKey, columnLetters, evaluateSheet, formatCellValue, parseCellKey } from '@nix/sheet';
import { TextRun } from 'docx';

import { paragraph, type BlockSpec, type CellSpec } from './blocks.js';

/**
 * A spreadsheet body, as a Word table.
 *
 * **Values, not formulas, and that is the loss.** The stored body holds each cell's raw text, so a
 * formula cell says `=SUM(A1:A9)` on disk. The grid goes through `@nix/sheet`'s own engine - the
 * same one the editor runs - so the number in the document is the number on screen, and the
 * substitution is recorded rather than left for the reader to notice.
 *
 * A Word table could in principle carry a real formula field, and deliberately does not: Word's
 * formula language is not this one, so a translated formula would be a new claim about what the
 * sheet computes rather than a faithful copy of it.
 */

/** What a page carries before the grid stops being readable rather than merely large. */
const PAGE_LIMITS = { columns: 8, rows: 40 } as const;

export function sheetTable(body: unknown, loss: LossSink): BlockSpec | null {
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

  // A blank corner cell so the column letters sit over the values rather than over the row numbers.
  const header: CellSpec[] = [{ blocks: [paragraph([])], shading: PRINT_PALETTE.surface }];

  for (let col = 0; col < columns; col += 1) {
    header.push({
      blocks: [paragraph([new TextRun({ text: columnLetters(col), bold: true })])],
      shading: PRINT_PALETTE.surface,
    });
  }

  const table: CellSpec[][] = [header];

  for (let row = 0; row < rows; row += 1) {
    const line: CellSpec[] = [
      {
        blocks: [paragraph([new TextRun({ text: String(row + 1), bold: true })])],
        shading: PRINT_PALETTE.surface,
      },
    ];

    for (let col = 0; col < columns; col += 1) {
      const value = values.get(cellKey({ row, col }));
      line.push({
        blocks: [
          paragraph([new TextRun({ text: value === undefined ? '' : formatCellValue(value) })]),
        ],
      });
    }

    table.push(line);
  }

  return { kind: 'table', rows: table, headerRow: true };
}

/**
 * The cell map out of a stored sheet body.
 *
 * Read defensively rather than through `@nix/sheet`'s document reader: that one wants a live
 * `Y.Doc`, and what an archive carries is the JSON snapshot of one. Cells are stored as `{ raw }`,
 * and one that is not is skipped rather than failing the export.
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
