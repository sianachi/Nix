import { describe, expect, it } from 'vitest';

import { parseTsv, rangeToTsv } from '../../sheet/clipboard';

describe('copying a range', () => {
  it('serializes raw text row by row, empty cells as empty fields', () => {
    const cells = new Map([
      ['A1', '1'],
      ['B1', '=A1*2'],
      ['A2', 'label'],
    ]);
    const tsv = rangeToTsv(cells, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 });
    expect(tsv).toBe('1\t=A1*2\nlabel\t');
  });
});

describe('pasting text', () => {
  it('splits rows on newlines and fields on tabs', () => {
    expect(parseTsv('1\t2\n3\t4')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('treats a trailing newline as a terminator, not an empty row', () => {
    expect(parseTsv('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('accepts Windows line endings', () => {
    expect(parseTsv('a\r\nb')).toEqual([['a'], ['b']]);
  });

  it('reads a single value as one cell', () => {
    expect(parseTsv('42')).toEqual([['42']]);
  });

  it('round-trips what the copy serialized', () => {
    const cells = new Map([
      ['A1', 'x'],
      ['B2', '=SUM(A1:A2)'],
    ]);
    const tsv = rangeToTsv(cells, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 });
    expect(parseTsv(tsv)).toEqual([
      ['x', ''],
      ['', '=SUM(A1:A2)'],
    ]);
  });
});
