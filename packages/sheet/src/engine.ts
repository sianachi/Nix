import { type FormulaNode } from './ast.js';
import { BudgetExhausted, type EvaluationContext } from './eval-types.js';
import { evaluateFormula } from './evaluator.js';
import { collectDependencies, orderFormulas } from './graph.js';
import { SHEET_LIMITS, type SheetLimits } from './limits.js';
import { parseFormula } from './parser.js';
import { cellKey, isInBounds } from './refs.js';
import { type CellValue, literalValue, sheetError } from './values.js';

/**
 * One full evaluation of a sheet. Full recalculation per call is a v1
 * decision made on purpose: with the op budget it is bounded and, for sheets
 * within limits, cheap. Incremental recalculation is an optimization that can
 * arrive later behind this same signature.
 *
 * The engine is deterministic by construction: no clock, no randomness, no
 * I/O. The same cells produce the same values in the browser and in the
 * collaboration service, which is what lets the server be the authority
 * without ever disagreeing with the editor.
 */

export interface SheetInput {
  /** Non-empty cells: canonical A1 key to raw text. */
  readonly cells: ReadonlyMap<string, string>;
}

export interface SheetBudgetReport {
  readonly opsUsed: number;
  readonly exceeded: boolean;
}

export interface SheetEvaluation {
  /** Every non-empty cell's evaluated value, keyed as the input. */
  readonly values: ReadonlyMap<string, CellValue>;
  readonly budget: SheetBudgetReport;
}

export function evaluateSheet(
  input: SheetInput,
  limits: SheetLimits = SHEET_LIMITS,
): SheetEvaluation {
  const values = new Map<string, CellValue>();
  const formulas = new Map<string, FormulaNode>();
  let opsUsed = 0;
  let exceeded = false;
  const charge = (count: number): void => {
    opsUsed += count;
    if (opsUsed > limits.maxOps) {
      exceeded = true;
      throw new BudgetExhausted();
    }
  };

  const formulaRaw = new Map<string, string>();
  for (const [key, raw] of input.cells) {
    if (raw.startsWith('=')) {
      formulaRaw.set(key, raw);
    } else {
      values.set(key, literalValue(raw));
    }
  }
  try {
    for (const [key, raw] of formulaRaw) {
      charge(raw.length);
      const parsed = parseFormula(raw.slice(1));
      if (parsed === null) {
        values.set(key, sheetError('#PARSE!'));
        continue;
      }
      formulas.set(key, parsed);
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) {
      throw error;
    }
  }

  const dependencies = new Map(
    [...formulas].map(([key, node]) => [key, collectDependencies(node)] as const),
  );
  const { order, cyclic } = orderFormulas(dependencies, charge);
  for (const key of cyclic) {
    values.set(key, sheetError('#CYCLE!'));
  }

  const ctx: EvaluationContext = {
    readCell: (row, col) => {
      if (!isInBounds({ row, col }, limits.maxRows, limits.maxCols)) {
        return sheetError('#REF!');
      }
      const key = cellKey({ row, col });
      const known = values.get(key);
      if (known !== undefined) {
        return known;
      }
      // A formula cell not yet in values is unreachable here: topological
      // order guarantees precedents evaluate first and cyclic cells were
      // pre-filled. Anything else is an empty or literal-free cell.
      return null;
    },
    charge,
  };

  // Skips itself when the budget was already spent during parsing: the first
  // charge() call inside evaluateFormula immediately throws, since opsUsed is
  // already past the ceiling.
  let position = 0;
  while (position < order.length) {
    const key = order[position];
    if (key === undefined) {
      break;
    }
    const node = formulas.get(key);
    if (node === undefined) {
      position += 1;
      continue;
    }
    try {
      values.set(key, evaluateFormula(node, ctx));
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) {
        throw error;
      }
      break;
    }
    position += 1;
  }

  // Every formula cell without a value by now - unparsed, unordered, or
  // interrupted mid-evaluation - reports the exhausted budget. When nothing
  // was exhausted this finds nothing to add: every formula cell already has
  // a value from the loop above or the cycle sweep.
  for (const key of formulaRaw.keys()) {
    if (!values.has(key)) {
      values.set(key, sheetError('#LIMIT!'));
    }
  }

  return { values, budget: { opsUsed, exceeded } };
}
