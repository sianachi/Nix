import { type CellRange } from './refs.js';
import { type CellValue } from './values.js';

/**
 * Shared shapes between the evaluator and the function registry, in their own
 * module so neither imports the other's implementation.
 */

/** A function argument: a scalar value, or a range read lazily through the context. */
export type Argument =
  | { readonly kind: 'value'; readonly value: CellValue }
  | { readonly kind: 'range'; readonly range: CellRange };

export interface EvaluationContext {
  /** The value of a cell, empty cells as null, out-of-bounds as #REF!. */
  readCell(row: number, col: number): CellValue;
  /**
   * Spend evaluation budget. Throws BudgetExhausted when the sheet's op
   * budget runs out; the engine catches it and marks the rest #LIMIT!.
   */
  charge(count: number): void;
}

/** Thrown by charge() when the op budget is spent. Never escapes the engine. */
export class BudgetExhausted extends Error {
  constructor() {
    super('sheet evaluation budget exhausted');
  }
}

/**
 * The longest text evaluation will produce. Concatenation in a loop is the
 * one way a formula could grow memory faster than it spends ops; the cap
 * turns that into #LIMIT! instead.
 */
export const MAX_TEXT_LENGTH = 32_768;
