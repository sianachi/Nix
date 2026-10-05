/**
 * Bounds the sheet body promises to hold, shared by the editor and the
 * collaboration service. The editor refuses to create what the server would
 * reject; the server refuses what it could not evaluate within budget.
 *
 * The version is independent of the note schema's SCHEMA_VERSION on purpose:
 * bumping one body kind must never force a migration of the other. It
 * starts at 1000, not 1, so the two axes' version numbers can never collide
 * by coincidence - the collaboration service's schema-version check is what
 * turns a body kind resolved wrong (an item whose type disagrees with the
 * kind its content_doc was created under) into a refusal rather than a
 * sheet silently opening as an empty note or the reverse. Two version
 * spaces that happen to both start at 1 cannot do that job.
 */

export const SHEET_SCHEMA_VERSION = 1000;

/** The item.type value this body kind draws for. */
export const SHEET_ITEM_TYPE = 'spreadsheet';

export interface SheetLimits {
  /** Rows in the address space, 1-based rows 1..maxRows. */
  readonly maxRows: number;
  /** Columns in the address space, A through ZZ. */
  readonly maxCols: number;
  /** Non-empty cells a document may hold. */
  readonly maxCells: number;
  /** Length of one cell's raw text, formula or literal. */
  readonly maxRawLength: number;
  /**
   * Evaluation budget for one full recalculation: every AST node visit and
   * every cell read out of a range costs one op. The budget makes evaluation
   * time a bound, not a hope, on both client and server.
   */
  readonly maxOps: number;
}

export const SHEET_LIMITS: SheetLimits = {
  maxRows: 10_000,
  maxCols: 702,
  maxCells: 50_000,
  maxRawLength: 2_048,
  maxOps: 500_000,
};
