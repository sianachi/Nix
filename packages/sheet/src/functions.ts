import { type Argument, type EvaluationContext, MAX_TEXT_LENGTH } from './eval-types.js';
import { type CellRange } from './refs.js';
import { type CellValue, isSheetError, sheetError, toBoolean, toNumber, toText } from './values.js';

/**
 * The v1 function set. Frozen deliberately small: every entry is implemented
 * on both client and server by being implemented once here, and growing the
 * set is an additive change with no migration.
 *
 * Range semantics follow the incumbents: aggregates skip text and booleans
 * inside ranges but coerce direct scalar arguments; errors always propagate.
 * AND and OR are eager (as in Excel, which does not short-circuit them);
 * only IF is lazy, and it lives in the evaluator for that reason.
 */

export type SheetFunction = (args: readonly Argument[], ctx: EvaluationContext) => CellValue;

function forEachRangeValue(
  range: CellRange,
  ctx: EvaluationContext,
  visit: (value: CellValue) => CellValue | undefined,
): CellValue | undefined {
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      ctx.charge(1);
      const stop = visit(ctx.readCell(row, col));
      if (stop !== undefined) {
        return stop;
      }
    }
  }
  return undefined;
}

interface NumberFold {
  readonly ok: true;
  sum: number;
  count: number;
  min: number;
  max: number;
}

interface FoldFailure {
  readonly ok: false;
  readonly error: CellValue;
}

/**
 * Fold numeric contents: range cells contribute only if they hold numbers,
 * scalar arguments are coerced, and any error wins immediately.
 */
function foldNumbers(args: readonly Argument[], ctx: EvaluationContext): NumberFold | FoldFailure {
  const state: NumberFold = { ok: true, sum: 0, count: 0, min: Infinity, max: -Infinity };
  const take = (n: number): void => {
    state.sum += n;
    state.count += 1;
    state.min = Math.min(state.min, n);
    state.max = Math.max(state.max, n);
  };
  for (const arg of args) {
    if (arg.kind === 'value') {
      if (arg.value === null) {
        continue;
      }
      const n = toNumber(arg.value);
      if (isSheetError(n)) {
        return { ok: false, error: n };
      }
      take(n);
      continue;
    }
    const failed = forEachRangeValue(arg.range, ctx, (value) => {
      if (isSheetError(value)) {
        return value;
      }
      if (typeof value === 'number') {
        take(value);
      }
      return undefined;
    });
    if (failed !== undefined) {
      return { ok: false, error: failed };
    }
  }
  return state;
}

function scalarOnly(arg: Argument | undefined): CellValue {
  if (arg === undefined) {
    return sheetError('#VALUE!');
  }
  if (arg.kind === 'range') {
    return sheetError('#VALUE!');
  }
  return arg.value;
}

function numberArg(arg: Argument | undefined): number | CellValue {
  const value = scalarOnly(arg);
  if (isSheetError(value)) {
    return value;
  }
  return toNumber(value);
}

function textArg(arg: Argument | undefined): string | CellValue {
  const value = scalarOnly(arg);
  if (isSheetError(value)) {
    return value;
  }
  return toText(value);
}

/**
 * Shift the decimal point through the exponent notation rather than by
 * multiplying, so ROUND(2.345, 2) sees 234.5 and not 234.4999...97.
 */
function decimalShift(value: number, digits: number): number {
  const [mantissa, exponent = '0'] = value.toExponential().split('e');
  return Number(`${mantissa ?? '0'}e${String(Number(exponent) + digits)}`);
}

function roundTo(value: number, digits: number, mode: 'nearest' | 'up' | 'down'): number {
  const d = Math.trunc(digits);
  const scaled = decimalShift(value, d);
  const rounded =
    mode === 'nearest'
      ? Math.round(Math.abs(scaled)) * Math.sign(scaled)
      : mode === 'up'
        ? Math.ceil(Math.abs(scaled)) * Math.sign(scaled)
        : Math.trunc(scaled);
  return decimalShift(rounded, -d);
}

function finite(value: number): CellValue {
  return Number.isFinite(value) ? value : sheetError('#VALUE!');
}

export const SHEET_FUNCTIONS: ReadonlyMap<string, SheetFunction> = new Map<string, SheetFunction>([
  [
    'SUM',
    (args, ctx) => {
      const folded = foldNumbers(args, ctx);
      return folded.ok ? folded.sum : folded.error;
    },
  ],
  [
    'AVERAGE',
    (args, ctx) => {
      const folded = foldNumbers(args, ctx);
      if (!folded.ok) {
        return folded.error;
      }
      return folded.count === 0 ? sheetError('#DIV/0!') : finite(folded.sum / folded.count);
    },
  ],
  [
    'MIN',
    (args, ctx) => {
      const folded = foldNumbers(args, ctx);
      if (!folded.ok) {
        return folded.error;
      }
      return folded.count === 0 ? 0 : folded.min;
    },
  ],
  [
    'MAX',
    (args, ctx) => {
      const folded = foldNumbers(args, ctx);
      if (!folded.ok) {
        return folded.error;
      }
      return folded.count === 0 ? 0 : folded.max;
    },
  ],
  [
    'COUNT',
    (args, ctx) => {
      let count = 0;
      for (const arg of args) {
        if (arg.kind === 'value') {
          if (isSheetError(arg.value)) {
            return arg.value;
          }
          if (typeof arg.value === 'number') {
            count += 1;
          }
          continue;
        }
        const failed = forEachRangeValue(arg.range, ctx, (value) => {
          if (isSheetError(value)) {
            return value;
          }
          if (typeof value === 'number') {
            count += 1;
          }
          return undefined;
        });
        if (failed !== undefined) {
          return failed;
        }
      }
      return count;
    },
  ],
  [
    'COUNTA',
    (args, ctx) => {
      let count = 0;
      for (const arg of args) {
        if (arg.kind === 'value') {
          if (isSheetError(arg.value)) {
            return arg.value;
          }
          if (arg.value !== null) {
            count += 1;
          }
          continue;
        }
        const failed = forEachRangeValue(arg.range, ctx, (value) => {
          if (isSheetError(value)) {
            return value;
          }
          if (value !== null) {
            count += 1;
          }
          return undefined;
        });
        if (failed !== undefined) {
          return failed;
        }
      }
      return count;
    },
  ],
  [
    'AND',
    (args, ctx) => {
      let result = true;
      for (const arg of args) {
        if (arg.kind === 'value') {
          const b = toBoolean(arg.value);
          if (isSheetError(b)) {
            return b;
          }
          result = result && b;
          continue;
        }
        const failed = forEachRangeValue(arg.range, ctx, (value) => {
          if (isSheetError(value)) {
            return value;
          }
          if (value === null || typeof value === 'string') {
            return undefined;
          }
          const b = toBoolean(value);
          if (isSheetError(b)) {
            return b;
          }
          result = result && b;
          return undefined;
        });
        if (failed !== undefined) {
          return failed;
        }
      }
      return result;
    },
  ],
  [
    'OR',
    (args, ctx) => {
      let result = false;
      for (const arg of args) {
        if (arg.kind === 'value') {
          const b = toBoolean(arg.value);
          if (isSheetError(b)) {
            return b;
          }
          result = result || b;
          continue;
        }
        const failed = forEachRangeValue(arg.range, ctx, (value) => {
          if (isSheetError(value)) {
            return value;
          }
          if (value === null || typeof value === 'string') {
            return undefined;
          }
          const b = toBoolean(value);
          if (isSheetError(b)) {
            return b;
          }
          result = result || b;
          return undefined;
        });
        if (failed !== undefined) {
          return failed;
        }
      }
      return result;
    },
  ],
  [
    'NOT',
    (args) => {
      const b = toBoolean(scalarOnly(args[0]));
      return isSheetError(b) ? b : !b;
    },
  ],
  [
    'ROUND',
    (args) => {
      const value = numberArg(args[0]);
      if (typeof value !== 'number') {
        return value;
      }
      const digits = args.length > 1 ? numberArg(args[1]) : 0;
      if (typeof digits !== 'number') {
        return digits;
      }
      return finite(roundTo(value, digits, 'nearest'));
    },
  ],
  [
    'ROUNDUP',
    (args) => {
      const value = numberArg(args[0]);
      if (typeof value !== 'number') {
        return value;
      }
      const digits = args.length > 1 ? numberArg(args[1]) : 0;
      if (typeof digits !== 'number') {
        return digits;
      }
      return finite(roundTo(value, digits, 'up'));
    },
  ],
  [
    'ROUNDDOWN',
    (args) => {
      const value = numberArg(args[0]);
      if (typeof value !== 'number') {
        return value;
      }
      const digits = args.length > 1 ? numberArg(args[1]) : 0;
      if (typeof digits !== 'number') {
        return digits;
      }
      return finite(roundTo(value, digits, 'down'));
    },
  ],
  [
    'ABS',
    (args) => {
      const value = numberArg(args[0]);
      return typeof value === 'number' ? Math.abs(value) : value;
    },
  ],
  [
    'INT',
    (args) => {
      const value = numberArg(args[0]);
      return typeof value === 'number' ? Math.floor(value) : value;
    },
  ],
  [
    'MOD',
    (args) => {
      const value = numberArg(args[0]);
      if (typeof value !== 'number') {
        return value;
      }
      const divisor = numberArg(args[1]);
      if (typeof divisor !== 'number') {
        return divisor;
      }
      if (divisor === 0) {
        return sheetError('#DIV/0!');
      }
      // Sign follows the divisor, as in the incumbents, not the remainder op.
      return finite(value - divisor * Math.floor(value / divisor));
    },
  ],
  [
    'SQRT',
    (args) => {
      const value = numberArg(args[0]);
      if (typeof value !== 'number') {
        return value;
      }
      return value < 0 ? sheetError('#VALUE!') : finite(Math.sqrt(value));
    },
  ],
  [
    'POWER',
    (args) => {
      const base = numberArg(args[0]);
      if (typeof base !== 'number') {
        return base;
      }
      const exponent = numberArg(args[1]);
      if (typeof exponent !== 'number') {
        return exponent;
      }
      return finite(base ** exponent);
    },
  ],
  [
    'CONCATENATE',
    (args) => {
      let out = '';
      for (const arg of args) {
        const text = textArg(arg);
        if (typeof text !== 'string') {
          return text;
        }
        out += text;
        if (out.length > MAX_TEXT_LENGTH) {
          return sheetError('#LIMIT!');
        }
      }
      return out;
    },
  ],
  [
    'LEN',
    (args) => {
      const text = textArg(args[0]);
      return typeof text === 'string' ? text.length : text;
    },
  ],
  [
    'LEFT',
    (args) => {
      const text = textArg(args[0]);
      if (typeof text !== 'string') {
        return text;
      }
      const count = args.length > 1 ? numberArg(args[1]) : 1;
      if (typeof count !== 'number') {
        return count;
      }
      if (count < 0) {
        return sheetError('#VALUE!');
      }
      return text.slice(0, Math.trunc(count));
    },
  ],
  [
    'RIGHT',
    (args) => {
      const text = textArg(args[0]);
      if (typeof text !== 'string') {
        return text;
      }
      const count = args.length > 1 ? numberArg(args[1]) : 1;
      if (typeof count !== 'number') {
        return count;
      }
      if (count < 0) {
        return sheetError('#VALUE!');
      }
      const n = Math.trunc(count);
      return n === 0 ? '' : text.slice(-n);
    },
  ],
  [
    'MID',
    (args) => {
      const text = textArg(args[0]);
      if (typeof text !== 'string') {
        return text;
      }
      const start = numberArg(args[1]);
      if (typeof start !== 'number') {
        return start;
      }
      const count = numberArg(args[2]);
      if (typeof count !== 'number') {
        return count;
      }
      if (start < 1 || count < 0) {
        return sheetError('#VALUE!');
      }
      const from = Math.trunc(start) - 1;
      return text.slice(from, from + Math.trunc(count));
    },
  ],
  [
    'TRIM',
    (args) => {
      const text = textArg(args[0]);
      return typeof text === 'string' ? text.trim().replace(/ +/g, ' ') : text;
    },
  ],
  [
    'UPPER',
    (args) => {
      const text = textArg(args[0]);
      return typeof text === 'string' ? text.toUpperCase() : text;
    },
  ],
  [
    'LOWER',
    (args) => {
      const text = textArg(args[0]);
      return typeof text === 'string' ? text.toLowerCase() : text;
    },
  ],
]);
