import type * as Y from 'yjs';

import { evaluateSheet, type SheetEvaluation } from './engine.js';
import { SHEET_LIMITS, type SheetLimits } from './limits.js';
import { readCellEntry, readCells, readMeta, sheetCellsMap } from './model.js';
import { formatCellValue, isSheetError } from './values.js';
import { parseCellKey } from './refs.js';

/**
 * What the collaboration service asks of a merged sheet document before it
 * accepts the update that produced it, and how a sheet is materialized into
 * a snapshot row. Validation is structural first and evaluated second: a
 * document that cannot be evaluated within budget is refused, because a
 * server that stores what it cannot compute has given up being the
 * authority.
 */

interface CachedEvaluation {
  readonly limits: SheetLimits;
  readonly cells: ReadonlyMap<string, string>;
  readonly evaluation: SheetEvaluation;
}

/**
 * One evaluation per document per call into this module, not per function.
 * The collaboration service calls `checkSheetDocument` on every accepted
 * update and `sheetSnapshot` only sometimes, on the same freshly loaded
 * `Y.Doc` and with no mutation between the two calls - so the second
 * evaluation would be identical work repeated for free. Keyed by the `Y.Doc`
 * instance rather than time, which needs no invalidation: a fresh document
 * is loaded per request (see `loadDocument` in the collaboration service),
 * so a stale entry can only be read by the same request that wrote it.
 */
const evaluationCache = new WeakMap<Y.Doc, CachedEvaluation>();

function readAndEvaluate(state: Y.Doc, limits: SheetLimits): CachedEvaluation {
  const cached = evaluationCache.get(state);
  if (cached?.limits === limits) {
    return cached;
  }
  const cells = readCells(state);
  const evaluation = evaluateSheet({ cells }, limits);
  const result: CachedEvaluation = { limits, cells, evaluation };
  evaluationCache.set(state, result);
  return result;
}

export interface SheetRejection {
  readonly code: 'sheet_invalid' | 'sheet_too_many_cells' | 'sheet_budget_exceeded';
  readonly message: string;
}

export function checkSheetDocument(
  state: Y.Doc,
  limits: SheetLimits = SHEET_LIMITS,
): SheetRejection | null {
  const cells = sheetCellsMap(state);
  if (cells.size > limits.maxCells) {
    return {
      code: 'sheet_too_many_cells',
      message: `The sheet holds ${String(cells.size)} cells; the bound is ${String(limits.maxCells)}.`,
    };
  }
  for (const [key, value] of cells) {
    const ref = parseCellKey(key);
    if (ref === null || !isRefInBounds(ref.row, ref.col, limits)) {
      return { code: 'sheet_invalid', message: `"${key}" is not a cell address on this sheet.` };
    }
    const entry = readCellEntry(value);
    if (entry === null) {
      return { code: 'sheet_invalid', message: `Cell ${key} does not hold { raw: string }.` };
    }
    if (entry.raw.length === 0) {
      return {
        code: 'sheet_invalid',
        message: `Cell ${key} stores empty text; an empty cell is an absent key.`,
      };
    }
    if (entry.raw.length > limits.maxRawLength) {
      return {
        code: 'sheet_invalid',
        message: `Cell ${key} holds ${String(entry.raw.length)} characters; the bound is ${String(limits.maxRawLength)}.`,
      };
    }
  }
  const { evaluation } = readAndEvaluate(state, limits);
  if (evaluation.budget.exceeded) {
    return {
      code: 'sheet_budget_exceeded',
      message: 'The sheet cannot be evaluated within its op budget.',
    };
  }
  return null;
}

function isRefInBounds(row: number, col: number, limits: SheetLimits): boolean {
  return row >= 0 && row < limits.maxRows && col >= 0 && col < limits.maxCols;
}

export interface SheetSnapshot {
  readonly json: {
    readonly body: 'sheet';
    readonly cells: Readonly<Record<string, string>>;
    readonly meta: { readonly rows: number; readonly cols: number };
  };
  /** The evaluated grid as tab-separated text, for search and export. */
  readonly plaintext: string;
}

/**
 * Rows*columns of the used bounding box the plaintext will cover before it
 * falls back to one line per cell. A sparse sheet with two far corners must
 * not materialize a hundred-megabyte rectangle of tabs.
 */
const PLAINTEXT_AREA_BOUND = 50_000;

export function sheetSnapshot(state: Y.Doc, limits: SheetLimits = SHEET_LIMITS): SheetSnapshot {
  const meta = readMeta(state);
  const { cells, evaluation } = readAndEvaluate(state, limits);
  const cellsJson: Record<string, string> = {};
  for (const [key, raw] of cells) {
    cellsJson[key] = raw;
  }

  let maxRow = -1;
  let maxCol = -1;
  const positioned = new Map<string, string>();
  for (const [key, value] of evaluation.values) {
    const ref = parseCellKey(key);
    if (ref === null) {
      continue;
    }
    maxRow = Math.max(maxRow, ref.row);
    maxCol = Math.max(maxCol, ref.col);
    positioned.set(`${String(ref.row)}:${String(ref.col)}`, formatCellValue(value));
  }

  let plaintext = '';
  const area = (maxRow + 1) * (maxCol + 1);
  if (maxRow >= 0 && area <= PLAINTEXT_AREA_BOUND) {
    const lines: string[] = [];
    for (let row = 0; row <= maxRow; row += 1) {
      const fields: string[] = [];
      for (let col = 0; col <= maxCol; col += 1) {
        fields.push(positioned.get(`${String(row)}:${String(col)}`) ?? '');
      }
      lines.push(fields.join('\t'));
    }
    plaintext = lines.join('\n');
  } else if (maxRow >= 0) {
    const lines: string[] = [];
    for (const [key, value] of evaluation.values) {
      if (isSheetError(value) || value === null) {
        continue;
      }
      lines.push(`${key}\t${formatCellValue(value)}`);
    }
    plaintext = lines.join('\n');
  }

  return {
    json: {
      body: 'sheet',
      cells: cellsJson,
      meta: { rows: meta.rows, cols: meta.cols },
    },
    plaintext,
  };
}
