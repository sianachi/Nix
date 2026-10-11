import { describe, expect, it } from 'vitest';

import { evaluateSheet } from './engine.js';
import { FORMULA_FUNCTION_ARITIES, SHEET_FUNCTIONS } from './functions.js';
import { type CellValue } from './values.js';

function evaluate(formula: string, cells: Record<string, string> = {}): CellValue {
  const input = new Map(Object.entries({ ...cells, Z99: `=${formula}` }));
  const result = evaluateSheet({ cells: input });
  return result.values.get('Z99') ?? null;
}

describe('aggregates', () => {
  it('sums scalars and ranges together', () => {
    expect(evaluate('SUM(1, 2, A1:A3)', { A1: '10', A2: '20', A3: '30' })).toBe(63);
  });

  it('coerces numeric text as a scalar argument but skips it inside a range', () => {
    expect(evaluate('SUM("5")')).toBe(5);
    expect(evaluate('SUM(A1:A2)', { A1: '5', A2: "'5" })).toBe(5);
  });

  it('averages only numeric cells and refuses an empty average', () => {
    expect(evaluate('AVERAGE(A1:A3)', { A1: '2', A2: '4', A3: 'label' })).toBe(3);
    expect(evaluate('AVERAGE(A1:A3)')).toEqual({ error: '#DIV/0!' });
  });

  it('answers MIN and MAX over the numeric contents, zero when none', () => {
    expect(evaluate('MIN(A1:A3)', { A1: '5', A2: '-2', A3: '9' })).toBe(-2);
    expect(evaluate('MAX(A1:A3)', { A1: '5', A2: '-2', A3: '9' })).toBe(9);
    expect(evaluate('MIN(A1:A3)')).toBe(0);
    expect(evaluate('MAX(A1:A3)')).toBe(0);
  });
});

describe('logic', () => {
  it('answers IF with the chosen branch', () => {
    expect(evaluate('IF(2>1, "yes", "no")')).toBe('yes');
    expect(evaluate('IF(2<1, "yes", "no")')).toBe('no');
  });

  it('is eager in AND and OR, so an error argument surfaces', () => {
    expect(evaluate('AND(FALSE, 1/0)')).toEqual({ error: '#DIV/0!' });
    expect(evaluate('OR(TRUE, 1/0)')).toEqual({ error: '#DIV/0!' });
  });

  it('combines AND and OR over scalars and ranges, skipping text cells', () => {
    expect(evaluate('AND(TRUE, 1)')).toBe(true);
    expect(evaluate('AND(TRUE, 0)')).toBe(false);
    expect(evaluate('OR(FALSE, 0)')).toBe(false);
    expect(evaluate('OR(A1:A2)', { A1: 'note', A2: '1' })).toBe(true);
  });

  it('negates with NOT', () => {
    expect(evaluate('NOT(TRUE)')).toBe(false);
    expect(evaluate('NOT(0)')).toBe(true);
  });
});

describe('numeric functions', () => {
  it('rounds to the named digits, half away from zero', () => {
    expect(evaluate('ROUND(2.5)')).toBe(3);
    expect(evaluate('ROUND(-2.5)')).toBe(-3);
    expect(evaluate('ROUND(2.345, 2)')).toBe(2.35);
    expect(evaluate('ROUNDUP(2.01)')).toBe(3);
    expect(evaluate('ROUNDDOWN(2.99)')).toBe(2);
  });

  it('answers ABS, INT, SQRT, and POWER', () => {
    expect(evaluate('ABS(-4)')).toBe(4);
    expect(evaluate('INT(-1.5)')).toBe(-2);
    expect(evaluate('SQRT(9)')).toBe(3);
    expect(evaluate('POWER(2, 10)')).toBe(1024);
  });

  it('gives MOD the sign of the divisor', () => {
    expect(evaluate('MOD(7, 3)')).toBe(1);
    expect(evaluate('MOD(-7, 3)')).toBe(2);
    expect(evaluate('MOD(7, -3)')).toBe(-2);
    expect(evaluate('MOD(7, 0)')).toEqual({ error: '#DIV/0!' });
  });

  it('refuses the square root of a negative', () => {
    expect(evaluate('SQRT(-1)')).toEqual({ error: '#VALUE!' });
  });
});

describe('text functions', () => {
  it('concatenates arguments and the & operator alike', () => {
    expect(evaluate('CONCATENATE("a", 1, TRUE)')).toBe('a1TRUE');
    expect(evaluate('"a" & "b" & 3')).toBe('ab3');
  });

  it('slices with LEFT, RIGHT, and MID using one-based positions', () => {
    expect(evaluate('LEFT("hello")')).toBe('h');
    expect(evaluate('LEFT("hello", 3)')).toBe('hel');
    expect(evaluate('RIGHT("hello", 2)')).toBe('lo');
    expect(evaluate('RIGHT("hello", 0)')).toBe('');
    expect(evaluate('MID("hello", 2, 3)')).toBe('ell');
  });

  it('measures, trims, and changes case', () => {
    expect(evaluate('LEN("abc")')).toBe(3);
    expect(evaluate('TRIM("  a   b  ")')).toBe('a b');
    expect(evaluate('UPPER("abc")')).toBe('ABC');
    expect(evaluate('LOWER("ABC")')).toBe('abc');
  });

  it('refuses negative slice counts', () => {
    expect(evaluate('LEFT("hello", -1)')).toEqual({ error: '#VALUE!' });
    expect(evaluate('MID("hello", 0, 2)')).toEqual({ error: '#VALUE!' });
  });
});

describe('operator semantics', () => {
  it('compares text case-insensitively and numbers numerically', () => {
    expect(evaluate('"Apple" = "apple"')).toBe(true);
    expect(evaluate('2 > 1')).toBe(true);
    expect(evaluate('"b" > "a"')).toBe(true);
    expect(evaluate('1 <> 2')).toBe(true);
  });

  it('treats percent as division by one hundred', () => {
    expect(evaluate('50% * 200')).toBe(100);
  });

  it('coerces numeric text in arithmetic and refuses words', () => {
    expect(evaluate('"5" + 1')).toBe(6);
    expect(evaluate('"five" + 1')).toEqual({ error: '#VALUE!' });
  });
});

describe('formula corrections and property-friendly functions', () => {
  it('exposes arity for every implemented function and both lazy functions', () => {
    expect([...FORMULA_FUNCTION_ARITIES.keys()].sort()).toEqual(
      [...SHEET_FUNCTIONS.keys(), 'IF', 'IFERROR'].sort(),
    );
  });
  it('keeps numeric results finite, including aggregate overflow', () => {
    expect(evaluate('SUM(1e308, 1e308)')).toEqual({ error: '#VALUE!' });
    expect(evaluate('SUM(1e308, 1e308) > 1e308')).toEqual({ error: '#VALUE!' });
    expect(evaluate('POWER(1e308, 2)')).toEqual({ error: '#VALUE!' });
  });

  it.each([
    'ABS(-2,99)',
    'ROUND(2.34,1,99)',
    'NOT(TRUE,FALSE)',
    'LEFT("hello",2,99)',
    'LEN()',
    'DAYS("2026-01-01")',
  ])('refuses the wrong argument count in %s', (expression) => {
    expect(evaluate(expression)).toEqual({ error: '#VALUE!' });
  });

  it('uses IFERROR only when an error occurs and keeps the other branch lazy', () => {
    expect(evaluate('IFERROR(1/0, 0)')).toBe(0);
    expect(evaluate('IFERROR(12, 1/0)')).toBe(12);
    expect(evaluate('IFERROR(SUM(1e308,1e308), 0)')).toBe(0);
    expect(evaluate('IFERROR(1/0, 2/0)')).toEqual({ error: '#DIV/0!' });
  });

  it('tests empty cells and empty text without treating zero, false, or spaces as blank', () => {
    expect(evaluate('ISBLANK(A1)')).toBe(true);
    expect(evaluate('ISBLANK("")')).toBe(true);
    for (const expression of ['ISBLANK(0)', 'ISBLANK(FALSE)', 'ISBLANK(" ")']) {
      expect(evaluate(expression)).toBe(false);
    }
  });

  it('converts numeric text and checks text containment without case sensitivity', () => {
    expect(evaluate('VALUE("12.5") * 2')).toBe(25);
    expect(evaluate('VALUE("words")')).toEqual({ error: '#VALUE!' });
    expect(evaluate('CONTAINS("Work, home", "WORK")')).toBe(true);
    expect(evaluate('CONTAINS("Work", "travel")')).toBe(false);
    expect(evaluate('CONTAINS("", "")')).toBe(true);
  });

  it('computes signed Gregorian day differences from ISO day strings', () => {
    expect(evaluate('DAYS("2026-10-11", "2026-10-01")')).toBe(10);
    expect(evaluate('DAYS("2026-10-01", "2026-10-11")')).toBe(-10);
    expect(evaluate('DAYS("2024-03-01", "2024-02-28")')).toBe(2);
    expect(evaluate('DAYS("2000-03-01", "2000-02-28")')).toBe(2);
    expect(evaluate('DAYS("1900-03-01", "1900-02-28")')).toBe(1);
    expect(evaluate('DAYS("0001-01-01", "9999-12-31")')).toBe(-3652058);
  });

  it.each([
    '2026-02-29',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-04-31',
    '0000-01-01',
    '10/11/2026',
    '2026-10-11T00:00:00Z',
  ])('refuses invalid or time-bearing day %s', (day) => {
    expect(evaluate(`DAYS("${day}", "2026-01-01")`)).toEqual({ error: '#VALUE!' });
  });
});
