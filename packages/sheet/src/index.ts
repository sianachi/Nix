/**
 * The Nix spreadsheet body.
 *
 * One definition of the cell document and one formula engine, imported by the
 * web editor to draw and recalculate the grid and by the collaboration
 * service to validate updates and materialize snapshots. Both sides computing
 * the same values from the same cells is the property this package exists to
 * hold; a second engine on either side is the bug.
 */

export { type FormulaNode } from './ast.js';
export {
  type SheetBudgetReport,
  type SheetEvaluation,
  type SheetInput,
  evaluateSheet,
} from './engine.js';
export { SHEET_ITEM_TYPE, SHEET_LIMITS, SHEET_SCHEMA_VERSION, type SheetLimits } from './limits.js';
export {
  SHEET_CELLS_KEY,
  SHEET_COLUMN_WIDTH,
  SHEET_META_KEY,
  type SheetCell,
  type SheetMeta,
  clampColumnWidth,
  growExtents,
  readCellEntry,
  readCells,
  readMeta,
  setColumnWidth,
  sheetCellsMap,
  sheetMetaMap,
  writeCell,
} from './model.js';
export { parseFormula } from './parser.js';
export {
  type A1Ref,
  type CellRange,
  type CellRef,
  cellKey,
  columnLetters,
  isInBounds,
  lettersToColumn,
  normalizeRange,
  parseA1,
  parseCellKey,
  rangeContains,
} from './refs.js';
export {
  type SheetRejection,
  type SheetSnapshot,
  type SheetSnapshotInput,
  checkSheetDocument,
  checkSheetSnapshot,
  sheetSnapshot,
} from './validate.js';
export {
  type CellValue,
  SHEET_ERROR_CODES,
  SHEET_ERROR_HELP,
  type SheetErrorCode,
  type SheetErrorValue,
  compareValues,
  formatCellValue,
  formatNumber,
  isSheetError,
  literalValue,
  sheetError,
} from './values.js';
