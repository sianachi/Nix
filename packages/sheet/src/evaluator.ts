import { type FormulaNode } from './ast.js';
import { type Argument, type EvaluationContext, MAX_TEXT_LENGTH } from './eval-types.js';
import { SHEET_FUNCTIONS } from './functions.js';
import { normalizeRange } from './refs.js';
import {
  type CellValue,
  compareValues,
  isSheetError,
  sheetError,
  toBoolean,
  toNumber,
  toText,
} from './values.js';

/**
 * Walks one parsed formula against a cell reader. Every node visit spends one
 * op from the shared budget, so evaluation time is bounded by SheetLimits
 * rather than by whatever the formula author had in mind.
 *
 * IF is evaluated here rather than in the registry because it is the one
 * function whose unchosen branch must not run: =IF(TRUE, 1, 1/0) is 1, not
 * #DIV/0!. AND and OR are eager, matching the incumbents.
 */
export function evaluateFormula(node: FormulaNode, ctx: EvaluationContext): CellValue {
  const arg = evaluateArgument(node, ctx);
  if (arg.kind === 'range') {
    // A bare range in scalar position (=A1:B2) has no single value. Spilling
    // is not in v1.
    return sheetError('#VALUE!');
  }
  return arg.value;
}

function evaluateArgument(node: FormulaNode, ctx: EvaluationContext): Argument {
  ctx.charge(1);
  switch (node.kind) {
    case 'number':
      return { kind: 'value', value: node.value };
    case 'string':
      return { kind: 'value', value: node.value };
    case 'boolean':
      return { kind: 'value', value: node.value };
    case 'ref':
      return { kind: 'value', value: ctx.readCell(node.ref.row, node.ref.col) };
    case 'range':
      return { kind: 'range', range: normalizeRange(node.start, node.end) };
    case 'unary': {
      const operand = evaluateFormula(node.operand, ctx);
      const n = toNumber(operand);
      if (isSheetError(n)) {
        return { kind: 'value', value: n };
      }
      return { kind: 'value', value: node.op === '-' ? -n : n };
    }
    case 'percent': {
      const operand = evaluateFormula(node.operand, ctx);
      const n = toNumber(operand);
      if (isSheetError(n)) {
        return { kind: 'value', value: n };
      }
      return { kind: 'value', value: n / 100 };
    }
    case 'binary':
      return { kind: 'value', value: evaluateBinary(node, ctx) };
    case 'call':
      return { kind: 'value', value: evaluateCall(node, ctx) };
  }
}

function evaluateBinary(
  node: Extract<FormulaNode, { kind: 'binary' }>,
  ctx: EvaluationContext,
): CellValue {
  const left = evaluateFormula(node.left, ctx);
  const right = evaluateFormula(node.right, ctx);
  switch (node.op) {
    case '&': {
      const l = toText(left);
      if (isSheetError(l)) {
        return l;
      }
      const r = toText(right);
      if (isSheetError(r)) {
        return r;
      }
      const joined = l + r;
      return joined.length > MAX_TEXT_LENGTH ? sheetError('#LIMIT!') : joined;
    }
    case '=': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order === 0;
    }
    case '<>': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order !== 0;
    }
    case '<': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order < 0;
    }
    case '<=': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order <= 0;
    }
    case '>': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order > 0;
    }
    case '>=': {
      const order = compareValues(left, right);
      return isSheetError(order) ? order : order >= 0;
    }
    default: {
      const l = toNumber(left);
      if (isSheetError(l)) {
        return l;
      }
      const r = toNumber(right);
      if (isSheetError(r)) {
        return r;
      }
      switch (node.op) {
        case '+':
          return finiteOrValueError(l + r);
        case '-':
          return finiteOrValueError(l - r);
        case '*':
          return finiteOrValueError(l * r);
        case '/':
          return r === 0 ? sheetError('#DIV/0!') : finiteOrValueError(l / r);
        case '^':
          return finiteOrValueError(l ** r);
      }
    }
  }
}

function finiteOrValueError(value: number): CellValue {
  return Number.isFinite(value) ? value : sheetError('#VALUE!');
}

function evaluateCall(
  node: Extract<FormulaNode, { kind: 'call' }>,
  ctx: EvaluationContext,
): CellValue {
  if (node.name === 'IF') {
    const first = node.args[0];
    if (first === undefined || node.args.length > 3) {
      return sheetError('#VALUE!');
    }
    const condition = toBoolean(evaluateFormula(first, ctx));
    if (isSheetError(condition)) {
      return condition;
    }
    if (condition) {
      const then = node.args[1];
      return then === undefined ? true : evaluateFormula(then, ctx);
    }
    const otherwise = node.args[2];
    return otherwise === undefined ? false : evaluateFormula(otherwise, ctx);
  }
  const fn = SHEET_FUNCTIONS.get(node.name);
  if (fn === undefined) {
    return sheetError('#NAME?');
  }
  const args: Argument[] = [];
  for (const argNode of node.args) {
    const arg = evaluateArgument(argNode, ctx);
    if (arg.kind === 'value' && isSheetError(arg.value)) {
      // Errors propagate into every eager function; only IF above escapes.
      return arg.value;
    }
    args.push(arg);
  }
  return fn(args, ctx);
}
