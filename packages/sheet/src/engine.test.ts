import { describe, expect, it } from 'vitest';

import { evaluateSheet } from './engine.js';
import { SHEET_LIMITS } from './limits.js';
import { type CellValue } from './values.js';

function sheet(entries: Record<string, string>): Map<string, CellValue> {
  const result = evaluateSheet({ cells: new Map(Object.entries(entries)) });
  return new Map(result.values);
}

describe('literals', () => {
  it('reads numbers, booleans, and text by their written form', () => {
    const values = sheet({ A1: '42', A2: 'true', A3: 'hello', A4: '3.5' });
    expect(values.get('A1')).toBe(42);
    expect(values.get('A2')).toBe(true);
    expect(values.get('A3')).toBe('hello');
    expect(values.get('A4')).toBe(3.5);
  });

  it('treats a leading apostrophe as text, whatever follows', () => {
    const values = sheet({ A1: "'42", A2: "'=SUM(1)" });
    expect(values.get('A1')).toBe('42');
    expect(values.get('A2')).toBe('=SUM(1)');
  });
});

describe('formulas over cells', () => {
  it('computes arithmetic over referenced cells', () => {
    const values = sheet({ A1: '4', A2: '3', A3: '=A1*A2+1' });
    expect(values.get('A3')).toBe(13);
  });

  it('reads an empty cell as zero in arithmetic', () => {
    const values = sheet({ A1: '=B9+5' });
    expect(values.get('A1')).toBe(5);
  });

  it('chains formulas through other formulas in dependency order', () => {
    const values = sheet({ C1: '=B1*2', B1: '=A1+1', A1: '10' });
    expect(values.get('B1')).toBe(11);
    expect(values.get('C1')).toBe(22);
  });

  it('sums a range that includes formula cells', () => {
    const values = sheet({ A1: '1', A2: '=A1+1', A3: '=SUM(A1:A2)' });
    expect(values.get('A3')).toBe(3);
  });

  it('skips text and booleans inside an aggregated range but counts them in COUNTA', () => {
    const values = sheet({
      A1: '1',
      A2: 'label',
      A3: 'TRUE',
      A4: '2',
      B1: '=SUM(A1:A4)',
      B2: '=COUNT(A1:A4)',
      B3: '=COUNTA(A1:A4)',
    });
    expect(values.get('B1')).toBe(3);
    expect(values.get('B2')).toBe(2);
    expect(values.get('B3')).toBe(4);
  });

  it('stores the exact binary sum; display formatting hides the noise', () => {
    const values = sheet({ A1: '0.1', A2: '0.2', A3: '=A1+A2' });
    expect(values.get('A3')).toBe(0.30000000000000004);
  });
});

describe('errors as values', () => {
  it('reports division by zero and propagates it through dependents', () => {
    const values = sheet({ A1: '=1/0', A2: '=A1+1', A3: '=SUM(A1:A2)' });
    expect(values.get('A1')).toEqual({ error: '#DIV/0!' });
    expect(values.get('A2')).toEqual({ error: '#DIV/0!' });
    expect(values.get('A3')).toEqual({ error: '#DIV/0!' });
  });

  it('reports an unknown function as #NAME?', () => {
    expect(sheet({ A1: '=NOPE(1)' }).get('A1')).toEqual({ error: '#NAME?' });
  });

  it('reports malformed text as #PARSE!', () => {
    expect(sheet({ A1: '=1+' }).get('A1')).toEqual({ error: '#PARSE!' });
  });

  it('reports a reference outside the address space as #REF!', () => {
    expect(sheet({ A1: '=ZZZ9999' }).get('A1')).toEqual({ error: '#REF!' });
    expect(sheet({ A1: '=A20000' }).get('A1')).toEqual({ error: '#REF!' });
  });

  it('shields the untaken branch of IF', () => {
    const values = sheet({ A1: '=IF(TRUE, 1, 1/0)' });
    expect(values.get('A1')).toBe(1);
  });
});

describe('cycles', () => {
  it('marks a self-reference as #CYCLE!', () => {
    expect(sheet({ A1: '=A1+1' }).get('A1')).toEqual({ error: '#CYCLE!' });
  });

  it('marks both halves of a two-cell cycle', () => {
    const values = sheet({ A1: '=B1', B1: '=A1' });
    expect(values.get('A1')).toEqual({ error: '#CYCLE!' });
    expect(values.get('B1')).toEqual({ error: '#CYCLE!' });
  });

  it('marks a cycle created through a range', () => {
    const values = sheet({ A1: '1', A2: '=SUM(A1:A3)', A3: '=A2' });
    expect(values.get('A2')).toEqual({ error: '#CYCLE!' });
    expect(values.get('A3')).toEqual({ error: '#CYCLE!' });
  });

  it('marks everything downstream of a cycle but leaves the healthy subgraph alone', () => {
    const values = sheet({
      A1: '=B1',
      B1: '=A1',
      C1: '=A1+1',
      D1: '=1+1',
    });
    expect(values.get('C1')).toEqual({ error: '#CYCLE!' });
    expect(values.get('D1')).toBe(2);
  });

  it('marks a long cycle whole', () => {
    const values = sheet({ A1: '=A2', A2: '=A3', A3: '=A4', A4: '=A1' });
    for (const key of ['A1', 'A2', 'A3', 'A4']) {
      expect(values.get(key)).toEqual({ error: '#CYCLE!' });
    }
  });
});

describe('the op budget', () => {
  it('reports exhaustion deterministically and marks starved cells #LIMIT!', () => {
    const cells = new Map<string, string>();
    // Each formula sums a 10,000-cell range: 40 of them cost at least 400k
    // range reads plus node visits, which cannot fit the 500k budget.
    for (let i = 0; i < 60; i += 1) {
      cells.set(`B${String(i + 1)}`, '=SUM(A1:A10000)+COUNT(A1:A10000)');
    }
    const first = evaluateSheet({ cells });
    const second = evaluateSheet({ cells });
    expect(first.budget.exceeded).toBe(true);
    expect(first.budget.opsUsed).toBe(second.budget.opsUsed);
    const limited = [...first.values.values()].filter(
      (v) => typeof v === 'object' && v !== null && v.error === '#LIMIT!',
    );
    expect(limited.length).toBeGreaterThan(0);
    expect(first.values.size).toBe(60);
  });

  it('evaluates a ten-thousand-cell sheet within budget', () => {
    const cells = new Map<string, string>();
    for (let row = 0; row < 5000; row += 1) {
      cells.set(`A${String(row + 1)}`, String(row));
      cells.set(`B${String(row + 1)}`, `=A${String(row + 1)}*2`);
    }
    const result = evaluateSheet({ cells });
    expect(result.budget.exceeded).toBe(false);
    expect(result.values.get('B5000')).toBe(9998);
  });

  it('never lets a formula see budget the limits do not grant', () => {
    const cells = new Map([['A1', '=SUM(A2:ZZ10000)']]);
    const result = evaluateSheet({ cells });
    expect(result.budget.opsUsed).toBeLessThanOrEqual(SHEET_LIMITS.maxOps + 1);
    expect(result.values.get('A1')).toEqual({ error: '#LIMIT!' });
  });

  it('builds the dependency graph for many range-referencing formulas in bounded time', () => {
    // Each formula sums a range spanning every other formula cell in the
    // sheet - the shape that cost seconds when the graph's edge resolution
    // scanned every formula cell for every range instead of only the rows
    // a range spans. 5,000 formulas is well under the cell ceiling and
    // should complete in milliseconds, not seconds, now that the same op
    // budget governs graph construction.
    const cells = new Map<string, string>();
    for (let i = 0; i < 5_000; i += 1) {
      cells.set(`B${String(i + 1)}`, `=SUM(B1:B${String(i + 1)})`);
    }
    const startedAt = performance.now();
    const result = evaluateSheet({ cells });
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.values.size).toBe(5_000);
  });
});
