import { describe, expect, it } from 'vitest';

import { parseFormula } from './parser.js';

describe('parsing literals and operators', () => {
  it('parses numbers, decimals, and exponents', () => {
    expect(parseFormula('42')).toEqual({ kind: 'number', value: 42 });
    expect(parseFormula('3.5')).toEqual({ kind: 'number', value: 3.5 });
    expect(parseFormula('1e3')).toEqual({ kind: 'number', value: 1000 });
    expect(parseFormula('.5')).toEqual({ kind: 'number', value: 0.5 });
  });

  it('parses strings with doubled-quote escapes', () => {
    expect(parseFormula('"a""b"')).toEqual({ kind: 'string', value: 'a"b' });
  });

  it('parses TRUE and FALSE in any case as booleans', () => {
    expect(parseFormula('TRUE')).toEqual({ kind: 'boolean', value: true });
    expect(parseFormula('false')).toEqual({ kind: 'boolean', value: false });
  });

  it('gives multiplication precedence over addition', () => {
    expect(parseFormula('1+2*3')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    });
  });

  it('gives exponent precedence over multiplication and keeps it left-associative', () => {
    expect(parseFormula('2^3^2')).toEqual({
      kind: 'binary',
      op: '^',
      left: {
        kind: 'binary',
        op: '^',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
      right: { kind: 'number', value: 2 },
    });
  });

  it('parses comparison loosest, so 1+1=2 compares the sum', () => {
    const node = parseFormula('1+1=2');
    expect(node).not.toBeNull();
    expect(node?.kind).toBe('binary');
    if (node?.kind === 'binary') {
      expect(node.op).toBe('=');
    }
  });

  it('distinguishes unary minus from subtraction', () => {
    expect(parseFormula('-3')).toEqual({
      kind: 'unary',
      op: '-',
      operand: { kind: 'number', value: 3 },
    });
    const node = parseFormula('2--3');
    expect(node?.kind).toBe('binary');
  });

  it('parses postfix percent tighter than the sign', () => {
    expect(parseFormula('50%')).toEqual({
      kind: 'percent',
      operand: { kind: 'number', value: 50 },
    });
  });

  it('honors parentheses over precedence', () => {
    const node = parseFormula('(1+2)*3');
    expect(node?.kind).toBe('binary');
    if (node?.kind === 'binary') {
      expect(node.op).toBe('*');
    }
  });
});

describe('parsing references, ranges, and calls', () => {
  it('parses a reference with anchors intact', () => {
    expect(parseFormula('$B$7')).toEqual({
      kind: 'ref',
      ref: { row: 6, col: 1, absRow: true, absCol: true },
    });
  });

  it('parses a range as its two corners', () => {
    const node = parseFormula('A1:B3');
    expect(node?.kind).toBe('range');
  });

  it('parses calls with nested expressions and normalizes the name', () => {
    const node = parseFormula('sum(A1:A3, 4+5)');
    expect(node?.kind).toBe('call');
    if (node?.kind === 'call') {
      expect(node.name).toBe('SUM');
      expect(node.args).toHaveLength(2);
    }
  });

  it('parses a call with no arguments', () => {
    const node = parseFormula('SUM()');
    expect(node?.kind).toBe('call');
  });
});

describe('malformed formulas', () => {
  it.each([
    ['1+', 'dangling operator'],
    ['(1', 'unclosed parenthesis'],
    ['"abc', 'unterminated string'],
    ['SUM(1,', 'unterminated argument list'],
    ['A1:', 'dangling range colon'],
    ['A1:SUM', 'range ending in a name'],
    ['1 2', 'two values with no operator'],
    ['#REF!', 'stray punctuation'],
    ['barename', 'a bare name is not a value'],
    ['', 'empty formula'],
  ])('returns null for %s (%s)', (text) => {
    expect(parseFormula(text)).toBeNull();
  });

  it('never throws, whatever the input', () => {
    const garbage = ['\\', '@@@', '=='.repeat(500), '((((((((((', 'A1:B2:C3', '$', '"'];
    for (const text of garbage) {
      expect(() => parseFormula(text)).not.toThrow();
    }
  });
});
